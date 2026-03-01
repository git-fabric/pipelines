/**
 * Pipeline 4 — Proxmox ↔ K8s Correlation
 *
 * Schedule: every 30 minutes
 *
 * Flow:
 *   1. pve_list_nodes           → Proxmox nodes
 *   2. pve_list_vms             → all VMs with status
 *   3. k8s_list_nodes           → k8s nodes with status + version
 *   4. Correlate: VM names ↔ k8s node names, flag mismatches
 *   5. k8s_list_longhorn_volumes → storage health
 *   6. pve_get_storage_status   → Proxmox storage health
 *   7. If mismatches/issues: chat session + log result
 */

import { callTool } from '../shared/gateway.js';
import { createSession, injectContext, sendMessage } from '../shared/chat.js';

const PIPELINE = '4-proxmox-k8s';

interface PveVm {
  name?: string;
  vmid?: number;
  status?: string;
  node?: string;
  [key: string]: unknown;
}

interface PveNode {
  node?: string;
  status?: string;
  [key: string]: unknown;
}

interface K8sNode {
  name?: string;
  status?: { ready?: boolean; conditions?: unknown[] };
  metadata?: { name?: string };
  [key: string]: unknown;
}

interface CorrelationEntry {
  name: string;
  vmStatus?: string;
  vmNode?: string;
  k8sReady?: boolean;
  mismatch: boolean;
  issue?: string;
}

function correlate(
  vms: PveVm[],
  k8sNodes: K8sNode[],
): { entries: CorrelationEntry[]; mismatches: CorrelationEntry[] } {
  const k8sByName = new Map<string, K8sNode>();
  for (const n of k8sNodes) {
    const name = n.metadata?.name ?? n.name ?? '';
    if (name) k8sByName.set(name.toLowerCase(), n);
  }

  const vmByName = new Map<string, PveVm>();
  for (const v of vms) {
    if (v.name) vmByName.set(v.name.toLowerCase(), v);
  }

  const entries: CorrelationEntry[] = [];

  // Check every VM against k8s nodes
  for (const vm of vms) {
    const name = vm.name ?? '';
    const k8sNode = k8sByName.get(name.toLowerCase());
    const vmRunning = vm.status === 'running';
    const k8sReady = k8sNode
      ? (k8sNode.status as { ready?: boolean } | undefined)?.ready !== false
      : undefined;

    let mismatch = false;
    let issue: string | undefined;

    if (!k8sNode && vmRunning) {
      // VM running but not a k8s node — informational, not necessarily an issue
    } else if (k8sNode) {
      if (vmRunning && k8sReady === false) {
        mismatch = true;
        issue = `VM running but k8s node NotReady`;
      } else if (!vmRunning && k8sReady === true) {
        mismatch = true;
        issue = `k8s node Ready but VM is ${vm.status}`;
      }
    }

    entries.push({
      name,
      vmStatus: vm.status,
      vmNode: vm.node,
      k8sReady,
      mismatch,
      issue,
    });
  }

  // k8s nodes with no matching VM
  for (const [nodeName, k8sNode] of k8sByName) {
    if (!vmByName.has(nodeName)) {
      const k8sReady = (k8sNode.status as { ready?: boolean } | undefined)?.ready !== false;
      entries.push({
        name: nodeName,
        vmStatus: undefined,
        k8sReady,
        mismatch: true,
        issue: 'k8s node has no matching Proxmox VM',
      });
    }
  }

  const mismatches = entries.filter((e) => e.mismatch);
  return { entries, mismatches };
}

async function run(): Promise<void> {
  console.log(`[${PIPELINE}] starting`);

  // Gather Proxmox + k8s data in parallel
  const [pveNodes, pveVms, k8sNodes, longhornVols] = await Promise.all([
    callTool('pve_list_nodes', {}),
    callTool('pve_list_vms', {}),
    callTool('k8s_list_nodes', {}),
    callTool('k8s_list_longhorn_volumes', {}),
  ]) as [unknown, unknown, unknown, unknown];

  const vms = (Array.isArray(pveVms) ? pveVms : []) as PveVm[];
  const nodes = (Array.isArray(k8sNodes) ? k8sNodes : []) as K8sNode[];
  const pveN = (Array.isArray(pveNodes) ? pveNodes : []) as PveNode[];

  // Get storage for each Proxmox node (pve_list_storage requires a node name)
  const pveStorageByNode: Record<string, unknown> = {};
  await Promise.all(
    pveN.map(async (n) => {
      if (n.node) {
        try {
          pveStorageByNode[n.node] = await callTool('pve_list_storage', { node: n.node });
        } catch {
          pveStorageByNode[n.node] = null;
        }
      }
    }),
  );
  const pveStorage = pveStorageByNode;

  console.log(
    `[${PIPELINE}] pve nodes: ${pveN.length}, vms: ${vms.length}, k8s nodes: ${nodes.length}`,
  );

  const { entries, mismatches } = correlate(vms, nodes);

  // Check for storage issues
  const lhVols = (Array.isArray(longhornVols) ? longhornVols : []) as Array<{
    status?: { robustness?: string };
    metadata?: { name?: string };
  }>;
  const degradedVols = lhVols.filter(
    (v) => v.status?.robustness && v.status.robustness !== 'Healthy',
  );

  const hasIssues = mismatches.length > 0 || degradedVols.length > 0;

  console.log(
    `[${PIPELINE}] mismatches: ${mismatches.length}, degraded volumes: ${degradedVols.length}`,
  );

  if (!hasIssues) {
    console.log(`[${PIPELINE}] all clear — no infrastructure inconsistencies`);
    return;
  }

  const contextLines = [
    `## Proxmox ↔ K8s Correlation (${new Date().toISOString()})`,
    '',
    `### Summary`,
    `- Proxmox nodes: ${pveN.length}`,
    `- VMs total: ${vms.length}`,
    `- K8s nodes: ${nodes.length}`,
    `- Correlation mismatches: ${mismatches.length}`,
    `- Degraded Longhorn volumes: ${degradedVols.length}`,
    '',
    '### Correlation Table',
    '```json',
    JSON.stringify(entries, null, 2),
    '```',
  ];

  if (mismatches.length > 0) {
    contextLines.push(
      '',
      `### Mismatches (${mismatches.length})`,
      '```json',
      JSON.stringify(mismatches, null, 2),
      '```',
    );
  }

  if (degradedVols.length > 0) {
    contextLines.push(
      '',
      `### Degraded Longhorn Volumes (${degradedVols.length})`,
      '```json',
      JSON.stringify(degradedVols, null, 2),
      '```',
    );
  }

  contextLines.push(
    '',
    '### Proxmox Storage Status',
    '```json',
    JSON.stringify(pveStorage, null, 2),
    '```',
  );

  const session = await createSession({
    project: 'infra-correlation',
    systemPrompt:
      'You are an infrastructure engineer correlating Proxmox hypervisor state with Kubernetes. ' +
      'Focus on VM/node state mismatches and storage health issues that could affect cluster stability. ' +
      'All data has been gathered already — do NOT call any tools, analyze only what is provided.',
  });

  await injectContext(session, contextLines.join('\n'));

  const analysis = await sendMessage(
    session,
    `Here is the infrastructure correlation data gathered at ${new Date().toISOString()}:\n\n` +
      contextLines.join('\n') +
      '\n\n---\n' +
      'Based ONLY on the data above (do not call any tools), are there any infrastructure inconsistencies to address? ' +
      'Explain each mismatch, its likely cause, and the recommended fix.',
  );

  console.log(`[${PIPELINE}] analysis:\n${analysis}`);
  console.log(`[${PIPELINE}] done`);
}

run().catch((err) => {
  console.error(`[${PIPELINE}] fatal:`, err);
  process.exit(1);
});
