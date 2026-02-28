/**
 * Pipeline 2 — GitOps Observer
 *
 * Schedule: every 15 minutes
 *
 * Flow:
 *   1. k8s_pod_problems      → failing/crashing pods
 *   2. k8s_list_argocd_apps  → sync/health status of all ArgoCD apps
 *   3. k8s_list_events       → recent Warning events
 *   4. If problems found:
 *      - chat_session_create  → gitops observer session
 *      - chat_context_inject  → problems + ArgoCD status + events
 *      - chat_message_send    → diagnose
 *      - git_pr_create        → open GitHub issue via PR
 *   5. If clean: log "all clear"
 */

import { callTool } from '../shared/gateway.js';
import { createSession, injectContext, sendMessage } from '../shared/chat.js';
import { dispatchKubectl } from '../shared/dispatch.js';
import { recordIncident } from '../shared/metrics.js';

const PIPELINE = '2-gitops-observer';

interface ArgoApp {
  name?: string;
  health?: { status?: string };
  sync?: { status?: string };
  [key: string]: unknown;
}

interface K8sEvent {
  reason?: string;
  message?: string;
  namespace?: string;
  involvedObject?: { name?: string; kind?: string };
  [key: string]: unknown;
}

function isDegraded(apps: ArgoApp[]): boolean {
  return apps.some(
    (a) =>
      a.health?.status !== 'Healthy' ||
      (a.sync?.status !== 'Synced' && a.sync?.status !== 'Unknown'),
  );
}

async function run(): Promise<void> {
  console.log(`[${PIPELINE}] starting`);

  // Gather data in parallel
  const [podProblems, argoApps, events] = await Promise.all([
    callTool('k8s_pod_problems', {}),
    callTool('k8s_list_argocd_apps', {}),
    callTool('k8s_list_events', { type: 'Warning', limit: 50 }),
  ]) as [unknown, unknown, unknown];

  const pods = (Array.isArray(podProblems) ? podProblems : []) as unknown[];
  const apps = (Array.isArray(argoApps) ? argoApps : []) as ArgoApp[];
  const warnings = (Array.isArray(events) ? events : []) as K8sEvent[];

  const hasPodProblems = pods.length > 0;
  const hasArgoDegraded = isDegraded(apps);
  const hasWarnings = warnings.length > 0;
  const hasIssues = hasPodProblems || hasArgoDegraded;

  console.log(
    `[${PIPELINE}] pods failing: ${pods.length}, ` +
      `argo degraded: ${hasArgoDegraded}, warnings: ${warnings.length}`,
  );

  if (!hasIssues) {
    console.log(`[${PIPELINE}] all clear — no issues detected`);
    return;
  }

  // Build context
  const contextLines: string[] = [
    `## Cluster Status (${new Date().toISOString()})`,
  ];

  if (hasPodProblems) {
    contextLines.push(
      '',
      `## Failing Pods (${pods.length})`,
      '```json',
      JSON.stringify(pods, null, 2),
      '```',
    );
  }

  if (hasArgoDegraded) {
    const degraded = apps.filter(
      (a) =>
        a.health?.status !== 'Healthy' ||
        (a.sync?.status !== 'Synced' && a.sync?.status !== 'Unknown'),
    );
    contextLines.push(
      '',
      `## Degraded ArgoCD Apps (${degraded.length} of ${apps.length} total)`,
      '```json',
      JSON.stringify(degraded, null, 2),
      '```',
    );
  }

  if (hasWarnings) {
    contextLines.push(
      '',
      `## Recent Warning Events (${warnings.length})`,
      '```json',
      JSON.stringify(warnings.slice(0, 20), null, 2),
      '```',
    );
  }

  // Chat: diagnose — embed all data directly in the message so Claude doesn't
  // need to call out to tools (the agentic loop is disabled by not setting FABRIC_GATEWAY_URL
  // inside the message, but we include all data inline to be safe).
  const session = await createSession({
    project: 'gitops-observer',
    systemPrompt:
      'You are a Kubernetes and GitOps SRE. Diagnose cluster issues concisely. ' +
      'Identify root causes, not symptoms. Suggest specific kubectl or ArgoCD commands to fix issues. ' +
      'The cluster data below has already been gathered — do NOT call any tools, just analyze what is provided.',
  });

  await injectContext(session, contextLines.join('\n'));

  const diagnosis = await sendMessage(
    session,
    `Here is the live cluster state gathered at ${new Date().toISOString()}:\n\n` +
      contextLines.join('\n') +
      '\n\n---\n' +
      "Based ONLY on the data above (do not call any tools), diagnose what's wrong and what should be fixed. " +
      'List each issue with: (1) root cause, (2) affected resources, (3) exact fix command.',
  );

  console.log(`[${PIPELINE}] diagnosis:\n${diagnosis}`);

  // Shared vars for PR and dispatch
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const issueSummary = [
    hasPodProblems && `${pods.length} failing pod(s)`,
    hasArgoDegraded && 'ArgoCD degraded',
  ]
    .filter(Boolean)
    .join(', ');

  // Phase 5: Parse diagnosis for actionable kubectl commands and dispatch them
  const jobIdBase = `gitops-observer/${timestamp}`;
  const kubectlPattern = /kubectl\s+((?:rollout restart|scale|delete pod|annotate|label)\s+[^\n`]+)/gi;
  const autoFixes: string[] = [];
  for (const match of diagnosis.matchAll(kubectlPattern)) {
    const cmd = match[1].trim().replace(/`/g, '');
    autoFixes.push(cmd);
  }

  if (autoFixes.length > 0) {
    console.log(`[${PIPELINE}] dispatching ${autoFixes.length} auto-fix(es):`);
    for (let i = 0; i < autoFixes.length; i++) {
      const cmd = autoFixes[i];
      console.log(`  [${i + 1}] kubectl ${cmd}`);
      const result = await dispatchKubectl({
        command: cmd,
        jobId: `${jobIdBase}-fix-${i + 1}`,
        reason: `gitops-observer auto-fix: ${issueSummary}`,
      });
      if (result.dispatched) {
        console.log(`  -> dispatched: ${result.runUrl}`);
      } else {
        console.warn(`  -> dispatch failed: ${result.error}`);
      }
    }
  } else {
    console.log(`[${PIPELINE}] no auto-dispatchable kubectl commands found in diagnosis`);
  }

  // Open a GitHub issue via PR to capture the diagnosis

  const branchName = `gitops-observer/${timestamp}`;
  const prBody =
    `## Automated GitOps Observation\n\n` +
    `**Detected at**: ${new Date().toISOString()}\n` +
    `**Issues**: ${issueSummary}\n\n` +
    `## Diagnosis\n\n${diagnosis}\n\n` +
    `---\n_Generated by fabric pipeline \`${PIPELINE}\`_`;

  try {
    await callTool('git_commit_push', {
      owner: 'ry-ops',
      repo: 'git-steer-state',
      branch: branchName,
      createBranch: true,
      fromBranch: 'main',
      message: `[gitops-observer] ${issueSummary}`,
      files: [
        {
          path: `reports/gitops-observer/${timestamp}.md`,
          content: prBody,
        },
      ],
    });
    await callTool('git_pr_create', {
      owner: 'ry-ops',
      repo: 'git-steer-state',
      title: `[GitOps Alert] ${issueSummary} — ${new Date().toLocaleDateString()}`,
      head: branchName,
      base: 'main',
      body: prBody,
    });
    console.log(`[${PIPELINE}] issue PR created`);
  } catch (err) {
    console.warn(`[${PIPELINE}] git_pr_create failed (non-fatal):`, err);
  }

  // Record MTTR incident metric
  await recordIncident({
    ts: new Date().toISOString(),
    pipeline: PIPELINE,
    issue: issueSummary,
    severity: pods.length > 0 ? 'high' : 'medium',
    autoDispatched: autoFixes.length > 0,
    dispatchCount: autoFixes.length,
  });

  console.log(`[${PIPELINE}] done`);
}

run().catch((err) => {
  console.error(`[${PIPELINE}] fatal:`, err);
  process.exit(1);
});
