/**
 * Pipeline 3 — Network Audit
 *
 * Schedule: daily at 02:00
 *
 * Flow:
 *   1. ts_list_devices      → all Tailscale devices
 *   2. unifi_list_devices   → all UniFi devices
 *   3. sandfly_list_hosts   → Sandfly-monitored hosts (active/inactive)
 *   4. Build reconciliation table: gaps in coverage, offline hosts
 *   5. cf_list_dns_records  → DNS records for ry-ops.dev zone
 *   6. chat session: identify gaps, stale DNS, unknown devices
 *   7. Store in chat session (searchable later)
 */

import { callTool } from '../shared/gateway.js';
import { createSession, injectContext, sendMessage } from '../shared/chat.js';

const PIPELINE = '3-network-audit';

const CF_ZONE_ID = process.env.CF_ZONE_ID ?? '055fc6396e0456826c7e31684284f5be';

interface TailscaleDevice {
  name?: string;
  addresses?: string[];
  lastSeen?: string;
  hostname?: string;
  [key: string]: unknown;
}

interface UnifiDevice {
  name?: string;
  ip?: string;
  mac?: string;
  state?: string;
  type?: string;
  [key: string]: unknown;
}

interface SandflyHost {
  hostname?: string;
  ip?: string;
  active?: boolean;
  last_seen?: string;
  [key: string]: unknown;
}

interface ReconciliationEntry {
  source: string;
  name: string;
  ip: string;
  inSandfly: boolean;
  sandflyActive?: boolean;
}

function buildReconciliationTable(
  tailscaleDevices: TailscaleDevice[],
  unifiDevices: UnifiDevice[],
  sandflyHosts: SandflyHost[],
): { table: ReconciliationEntry[]; gaps: string[]; inactive: string[] } {
  const sandflyByIp = new Map<string, SandflyHost>();
  const sandflyByName = new Map<string, SandflyHost>();
  for (const h of sandflyHosts) {
    if (h.ip) sandflyByIp.set(h.ip, h);
    if (h.hostname) sandflyByName.set(h.hostname.toLowerCase(), h);
  }

  const table: ReconciliationEntry[] = [];
  const gaps: string[] = [];
  const inactive: string[] = [];

  for (const d of tailscaleDevices) {
    const ip = d.addresses?.[0] ?? '';
    const name = d.name ?? d.hostname ?? ip;
    const sfHost = sandflyByIp.get(ip) ?? sandflyByName.get(name.toLowerCase().split('.')[0]);
    const inSandfly = !!sfHost;
    table.push({ source: 'tailscale', name, ip, inSandfly, sandflyActive: sfHost?.active });
    if (!inSandfly) gaps.push(`Tailscale: ${name} (${ip}) — not in Sandfly`);
    else if (!sfHost?.active) inactive.push(`Sandfly: ${name} (${ip}) — inactive`);
  }

  for (const d of unifiDevices) {
    const ip = d.ip ?? '';
    const name = d.name ?? ip;
    const sfHost = sandflyByIp.get(ip) ?? sandflyByName.get(name.toLowerCase());
    const inSandfly = !!sfHost;
    table.push({ source: 'unifi', name, ip, inSandfly, sandflyActive: sfHost?.active });
    if (!inSandfly) gaps.push(`UniFi: ${name} (${ip}) — not in Sandfly`);
    else if (!sfHost?.active) inactive.push(`Sandfly: ${name} (${ip}) — inactive`);
  }

  // Sandfly hosts not found on Tailscale or UniFi — potentially stale
  for (const h of sandflyHosts) {
    const ip = h.ip ?? '';
    const name = h.hostname ?? ip;
    const onTailscale = tailscaleDevices.some(
      (d) => d.addresses?.includes(ip) || d.hostname === name,
    );
    const onUnifi = unifiDevices.some((d) => d.ip === ip || d.name === name);
    if (!onTailscale && !onUnifi) {
      gaps.push(`Sandfly: ${name} (${ip}) — not found on Tailscale or UniFi (possibly stale)`);
    }
  }

  return { table, gaps, inactive };
}

async function run(): Promise<void> {
  console.log(`[${PIPELINE}] starting`);

  // Gather all network data in parallel
  const [tsDevices, unifiDevices, sandflyHosts, dnsRecords] = await Promise.all([
    callTool('ts_list_devices', {}),
    callTool('unifi_list_devices', {}),
    callTool('sandfly_list_hosts', {}),
    callTool('cf_list_dns_records', { zone_id: CF_ZONE_ID }),
  ]) as [unknown, unknown, unknown, unknown];

  const ts = (Array.isArray(tsDevices) ? tsDevices : []) as TailscaleDevice[];
  const unifi = (Array.isArray(unifiDevices) ? unifiDevices : []) as UnifiDevice[];
  const sandfly = (Array.isArray(sandflyHosts) ? sandflyHosts : []) as SandflyHost[];
  const dns = (Array.isArray(dnsRecords) ? dnsRecords : []) as unknown[];

  console.log(
    `[${PIPELINE}] tailscale: ${ts.length}, unifi: ${unifi.length}, ` +
      `sandfly: ${sandfly.length}, dns: ${dns.length}`,
  );

  const { table, gaps, inactive } = buildReconciliationTable(ts, unifi, sandfly);

  const contextLines = [
    `## Network Audit (${new Date().toISOString()})`,
    '',
    `### Device Counts`,
    `- Tailscale: ${ts.length}`,
    `- UniFi: ${unifi.length}`,
    `- Sandfly hosts: ${sandfly.length} (active: ${sandfly.filter((h) => h.active).length})`,
    `- DNS records: ${dns.length}`,
    '',
    '### Reconciliation Table',
    '```json',
    JSON.stringify(table, null, 2),
    '```',
    '',
    `### Coverage Gaps (${gaps.length})`,
    gaps.length > 0 ? gaps.map((g) => `- ${g}`).join('\n') : '_none_',
    '',
    `### Inactive Sandfly Hosts (${inactive.length})`,
    inactive.length > 0 ? inactive.map((i) => `- ${i}`).join('\n') : '_none_',
    '',
    `### DNS Records (ry-ops.dev)`,
    '```json',
    JSON.stringify(dns, null, 2),
    '```',
  ];

  const session = await createSession({
    project: 'network-audit',
    systemPrompt:
      'You are a network security auditor reviewing homelab network coverage. ' +
      'Focus on: devices not monitored by Sandfly, stale DNS entries pointing nowhere, ' +
      'unknown devices on the network, and inactive Sandfly hosts that should be active.',
    tags: ['automated', 'network-audit', 'daily'],
  });

  await injectContext(session, contextLines.join('\n'));

  const report = await sendMessage(
    session,
    'Identify coverage gaps, stale DNS entries, and unknown or unmonitored devices. ' +
      'Provide a prioritized list of remediation actions.',
  );

  console.log(`[${PIPELINE}] audit report:\n${report}`);
  console.log(`[${PIPELINE}] done (session stored for search)`);
}

run().catch((err) => {
  console.error(`[${PIPELINE}] fatal:`, err);
  process.exit(1);
});
