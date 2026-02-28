/**
 * Pipeline 5 — Daily Ops Briefing
 *
 * Schedule: daily at 08:00
 *
 * Flow:
 *   1. Parallel data gather:
 *      - k8s_pod_problems, k8s_list_argocd_apps, k8s_cluster_info
 *      - sandfly_get_alerts, cve_queue_stats
 *      - ts_list_devices
 *      - pve_list_vms
 *   2. chat_search → recent security/gitops/network findings (last 24h)
 *   3. chat_session_create → daily briefing session (claude-opus-4-6)
 *   4. chat_context_inject → all data + yesterday's search results
 *   5. chat_message_send → concise daily briefing
 *   6. Session stored and searchable
 */

import { callTool } from '../shared/gateway.js';
import {
  createSession,
  injectContext,
  sendMessage,
  searchSessions,
} from '../shared/chat.js';

const PIPELINE = '5-ops-chat';

function safe(label: string, result: unknown): string {
  if (result === null || result === undefined) return `_${label}: no data_`;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

async function run(): Promise<void> {
  console.log(`[${PIPELINE}] starting daily ops briefing`);

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // 1. Gather all operational data in parallel
  const [
    podProblems,
    argoApps,
    clusterInfo,
    sandflyAlerts,
    cveStats,
    tailscaleDevices,
    pveVms,
  ] = await Promise.allSettled([
    callTool('k8s_pod_problems', {}),
    callTool('k8s_list_argocd_apps', {}),
    callTool('k8s_cluster_info', {}),
    callTool('sandfly_get_alerts', { acknowledged: false, since: since24h }),
    callTool('cve_queue_stats', {}),
    callTool('ts_list_devices', {}),
    callTool('pve_list_vms', {}),
  ]);

  console.log(`[${PIPELINE}] data gather complete`);

  // 2. Search recent sessions for findings
  const [securityFindings, gitopsFindings, networkFindings] = await Promise.allSettled([
    searchSessions({ query: 'security alerts CVE triage', project: 'security-triage', hoursBack: 24 }),
    searchSessions({ query: 'failing pods ArgoCD degraded', project: 'gitops-observer', hoursBack: 24 }),
    searchSessions({ query: 'network gaps coverage stale DNS', project: 'network-audit', hoursBack: 48 }),
  ]);

  console.log(`[${PIPELINE}] session search complete`);

  // Build comprehensive context
  const contextLines = [
    `# Daily Ops Briefing Context — ${new Date().toLocaleDateString()}`,
    `_Generated at ${new Date().toISOString()}_`,
    '',
    '## Cluster Health',
    '',
    '### Cluster Info',
    '```json',
    safe('cluster_info', clusterInfo.status === 'fulfilled' ? clusterInfo.value : clusterInfo.reason),
    '```',
    '',
    '### Failing Pods',
    '```json',
    safe('pod_problems', podProblems.status === 'fulfilled' ? podProblems.value : podProblems.reason),
    '```',
    '',
    '### ArgoCD Apps',
    '```json',
    safe('argocd_apps', argoApps.status === 'fulfilled' ? argoApps.value : argoApps.reason),
    '```',
    '',
    '## Security',
    '',
    '### Sandfly Alerts (last 24h)',
    '```json',
    safe('sandfly_alerts', sandflyAlerts.status === 'fulfilled' ? sandflyAlerts.value : sandflyAlerts.reason),
    '```',
    '',
    '### CVE Queue Stats',
    '```json',
    safe('cve_stats', cveStats.status === 'fulfilled' ? cveStats.value : cveStats.reason),
    '```',
    '',
    '## Network',
    '',
    '### Tailscale Devices',
    '```json',
    safe('tailscale', tailscaleDevices.status === 'fulfilled' ? tailscaleDevices.value : tailscaleDevices.reason),
    '```',
    '',
    '## Infrastructure',
    '',
    '### Proxmox VMs',
    '```json',
    safe('pve_vms', pveVms.status === 'fulfilled' ? pveVms.value : pveVms.reason),
    '```',
  ];

  // Add previous pipeline findings
  const prevFindings = [
    { label: 'Security Triage (last 24h)', result: securityFindings },
    { label: 'GitOps Observer (last 24h)', result: gitopsFindings },
    { label: 'Network Audit (last 48h)', result: networkFindings },
  ];

  const hasFindings = prevFindings.some((f) => f.result.status === 'fulfilled');

  if (hasFindings) {
    contextLines.push('', '## Previous Pipeline Findings');
    for (const { label, result } of prevFindings) {
      contextLines.push(
        '',
        `### ${label}`,
        '```json',
        safe(label, result.status === 'fulfilled' ? result.value : result.reason),
        '```',
      );
    }
  }

  // 3-5. Create briefing session and get the daily briefing
  const session = await createSession({
    project: 'daily-briefing',
    model: 'claude-opus-4-6',
    systemPrompt:
      'You are an experienced SRE providing a concise daily operations briefing for a homelab k3s cluster. ' +
      'The homelab runs: 3 master + 4 worker k3s nodes, ArgoCD GitOps, Sandfly security monitoring, ' +
      'Proxmox hypervisor, Tailscale mesh, UniFi networking, and Cloudflare DNS. ' +
      'Be concise. Use sections: Health, Security, Network, Infrastructure, Action Items. ' +
      'Only call out things that need attention — skip "everything is fine" noise.',
    tags: ['automated', 'daily-briefing'],
  });

  await injectContext(session, contextLines.join('\n'));

  const briefing = await sendMessage(
    session,
    'Give me a concise daily ops briefing: cluster health, security posture, network status, ' +
      'and anything needing attention today. Keep it under 400 words.',
  );

  console.log(`[${PIPELINE}] briefing:\n`);
  console.log('─'.repeat(60));
  console.log(briefing);
  console.log('─'.repeat(60));
  console.log(`[${PIPELINE}] done — session stored and searchable`);
}

run().catch((err) => {
  console.error(`[${PIPELINE}] fatal:`, err);
  process.exit(1);
});
