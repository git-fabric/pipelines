/**
 * Pipeline 1 — Security Triage
 *
 * Schedule: every 6 hours
 *
 * Flow:
 *   1. sandfly_get_alerts     → unacknowledged alerts
 *   2. cve_enrich             → severity + patch status for any CVE tags
 *   3. cve_triage             → AI triage on the batch
 *   4. chat_session_create    → security analyst session
 *   5. chat_context_inject    → alert + CVE data
 *   6. chat_message_send      → summarize + prioritize
 *   7. git_pr_create          → durable record as a PR in the state repo
 */

import { callTool } from '../shared/gateway.js';
import { createSession, injectContext, sendMessage } from '../shared/chat.js';
import { dispatchKubectl } from '../shared/dispatch.js';
import { recordIncident } from '../shared/metrics.js';

const PIPELINE = '1-security-triage';

interface SandflyAlert {
  id: string;
  tags?: string[];
  host?: string;
  alert_name?: string;
  severity?: string;
  created_at?: string;
  [key: string]: unknown;
}

function extractCveIds(alerts: SandflyAlert[]): string[] {
  const cvePattern = /CVE-\d{4}-\d+/gi;
  const ids = new Set<string>();
  for (const alert of alerts) {
    const raw = JSON.stringify(alert);
    for (const match of raw.matchAll(cvePattern)) {
      ids.add(match[0].toUpperCase());
    }
  }
  return [...ids];
}

async function run(): Promise<void> {
  console.log(`[${PIPELINE}] starting`);

  // 1. Fetch unacknowledged Sandfly alerts from the last 6 hours
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const alertsResult = (await callTool('sandfly_get_alerts', {
    acknowledged: false,
    since,
  })) as { alerts?: SandflyAlert[] } | SandflyAlert[];

  const alerts: SandflyAlert[] = Array.isArray(alertsResult)
    ? alertsResult
    : (alertsResult.alerts ?? []);

  console.log(`[${PIPELINE}] found ${alerts.length} unacknowledged alerts`);

  if (alerts.length === 0) {
    console.log(`[${PIPELINE}] no alerts — done`);
    return;
  }

  // 2. Enrich any CVE IDs found in the alerts
  const cveIds = extractCveIds(alerts);
  const enrichedCves: Record<string, unknown> = {};

  if (cveIds.length > 0) {
    console.log(`[${PIPELINE}] enriching ${cveIds.length} CVEs: ${cveIds.join(', ')}`);
    await Promise.all(
      cveIds.map(async (id) => {
        try {
          enrichedCves[id] = await callTool('cve_enrich', { cve_id: id });
        } catch (err) {
          console.warn(`[${PIPELINE}] failed to enrich ${id}:`, err);
          enrichedCves[id] = { error: String(err) };
        }
      }),
    );
  }

  // 3. AI triage on the full batch
  let triageResult: unknown;
  try {
    triageResult = await callTool('cve_triage', {
      alerts: JSON.stringify(alerts),
      cves: JSON.stringify(enrichedCves),
    });
  } catch (err) {
    console.warn(`[${PIPELINE}] cve_triage skipped:`, err);
    triageResult = null;
  }

  // 4–6. Chat session: summarize + prioritize
  const session = await createSession({
    project: 'security-triage',
    systemPrompt:
      'You are a security analyst reviewing homelab security alerts. ' +
      'Be concise, prioritize by severity and exploitability, and suggest specific remediation steps. ' +
      'All data has been gathered already — do NOT call any tools, analyze only what is provided.',
  });

  const contextLines = [
    `## Sandfly Alerts (${alerts.length} unacknowledged since ${since})`,
    '```json',
    JSON.stringify(alerts, null, 2),
    '```',
  ];

  if (cveIds.length > 0) {
    contextLines.push(
      '',
      `## CVE Enrichment (${cveIds.length} CVEs)`,
      '```json',
      JSON.stringify(enrichedCves, null, 2),
      '```',
    );
  }

  if (triageResult) {
    contextLines.push(
      '',
      '## AI Triage Pre-analysis',
      '```json',
      JSON.stringify(triageResult, null, 2),
      '```',
    );
  }

  await injectContext(session, contextLines.join('\n'));

  const summary = await sendMessage(
    session,
    `Here is the security data gathered at ${new Date().toISOString()}:\n\n` +
      contextLines.join('\n') +
      '\n\n---\n' +
      'Based ONLY on the data above (do not call any tools), summarize these security findings and prioritize remediation. ' +
      'Group by severity, identify any CVEs with available patches, ' +
      'and list the top 3 actions to take immediately.',
  );

  console.log(`[${PIPELINE}] summary:\n${summary}`);

  // Phase 5: Dispatch kubectl rollout restart for any affected fabric deployments
  // Claude will mention specific deployments in the summary when they need patching
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fabricDeployPattern = /rollout restart deploy\/(fabric-[a-z-]+)\s+-n\s+(cortex-system)/gi;
  const restarts: Array<{ deploy: string; ns: string }> = [];
  for (const match of summary.matchAll(fabricDeployPattern)) {
    restarts.push({ deploy: match[1], ns: match[2] });
  }

  if (restarts.length > 0) {
    console.log(`[${PIPELINE}] dispatching ${restarts.length} restart(s) for affected fabric deployments`);
    for (const { deploy, ns } of restarts) {
      await dispatchKubectl({
        command: `rollout restart deploy/${deploy} -n ${ns}`,
        jobId: `security-triage/${timestamp}/${deploy}`,
        reason: `security-triage: CVE patch rollout for ${deploy}`,
      });
    }
  }

  // 7. Open a PR in the state repo as a durable record
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const branchName = `security-triage/${timestamp}`;
  const prBody =
    `## Automated Security Triage\n\n` +
    `**Run at**: ${new Date().toISOString()}\n` +
    `**Alerts**: ${alerts.length}\n` +
    `**CVEs found**: ${cveIds.length > 0 ? cveIds.join(', ') : 'none'}\n\n` +
    `## Summary\n\n${summary}\n\n` +
    `---\n_Generated by fabric pipeline \`${PIPELINE}\`_`;

  try {
    // Push a report file to a new branch, then open a PR from it
    await callTool('git_commit_push', {
      owner: 'ry-ops',
      repo: 'git-steer-state',
      branch: branchName,
      createBranch: true,
      fromBranch: 'main',
      message: `[security-triage] ${alerts.length} alert(s) — ${new Date().toLocaleDateString()}`,
      files: [
        {
          path: `reports/security-triage/${timestamp}.md`,
          content: prBody,
        },
      ],
    });
    await callTool('git_pr_create', {
      owner: 'ry-ops',
      repo: 'git-steer-state',
      title: `[Security Triage] ${alerts.length} alert(s) — ${new Date().toLocaleDateString()}`,
      head: branchName,
      base: 'main',
      body: prBody,
    });
    console.log(`[${PIPELINE}] PR created on branch ${branchName}`);
  } catch (err) {
    console.warn(`[${PIPELINE}] git_pr_create failed (non-fatal):`, err);
  }

  // Record MTTR incident metric
  const criticalAlerts = alerts.filter((a) => a.severity === 'critical' || a.severity === 'high');
  await recordIncident({
    ts: new Date().toISOString(),
    pipeline: PIPELINE,
    issue: `${alerts.length} alert(s), ${cveIds.length} CVE(s): ${cveIds.join(', ') || 'none'}`,
    severity: criticalAlerts.length > 0 ? 'critical' : alerts.length > 0 ? 'high' : 'info',
    autoDispatched: restarts.length > 0,
    dispatchCount: restarts.length,
  });

  console.log(`[${PIPELINE}] done`);
}

run().catch((err) => {
  console.error(`[${PIPELINE}] fatal:`, err);
  process.exit(1);
});
