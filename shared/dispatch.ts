/**
 * Dispatch helper — triggers GitHub Actions workflows in cortex-gitops
 * to execute kubectl or helm operations and record results in git-steer-state.
 */

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITOPS_REPO = process.env.GITOPS_REPO ?? 'cortex-io/cortex-gitops';
const API_BASE = 'https://api.github.com';

export interface DispatchResult {
  dispatched: boolean;
  runUrl?: string;
  error?: string;
}

/**
 * Trigger the kubectl-dispatch workflow.
 * command — kubectl subcommand WITHOUT the "kubectl" prefix
 *           e.g. "rollout restart deploy/fabric-chat -n cortex-system"
 */
export async function dispatchKubectl(opts: {
  command: string;
  jobId: string;
  reason: string;
  dryRun?: boolean;
}): Promise<DispatchResult> {
  return dispatchWorkflow('kubectl-dispatch', {
    command: opts.command,
    job_id: opts.jobId,
    reason: opts.reason,
    dry_run: opts.dryRun ? 'true' : 'false',
  });
}

/**
 * Trigger the helm-dispatch workflow.
 */
export async function dispatchHelm(opts: {
  release: string;
  namespace: string;
  chart: string;
  values?: Record<string, string>;
  jobId: string;
  reason: string;
  dryRun?: boolean;
}): Promise<DispatchResult> {
  return dispatchWorkflow('helm-dispatch', {
    release: opts.release,
    namespace: opts.namespace,
    chart: opts.chart,
    values: JSON.stringify(opts.values ?? {}),
    job_id: opts.jobId,
    reason: opts.reason,
    dry_run: opts.dryRun ? 'true' : 'false',
  });
}

async function dispatchWorkflow(
  eventType: string,
  payload: Record<string, unknown>,
): Promise<DispatchResult> {
  if (!GITHUB_TOKEN) {
    console.warn('[dispatch] GITHUB_TOKEN not set — skipping dispatch');
    return { dispatched: false, error: 'GITHUB_TOKEN not set' };
  }

  const [owner, repo] = GITOPS_REPO.split('/');
  const url = `${API_BASE}/repos/${owner}/${repo}/dispatches`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        event_type: eventType,
        client_payload: payload,
      }),
    });

    if (res.status === 204) {
      const runUrl = `https://github.com/${GITOPS_REPO}/actions`;
      console.log(`[dispatch] dispatched ${eventType} — ${runUrl}`);
      return { dispatched: true, runUrl };
    } else {
      const body = await res.text();
      const error = `GitHub dispatch failed: ${res.status} ${body}`;
      console.warn(`[dispatch] ${error}`);
      return { dispatched: false, error };
    }
  } catch (err) {
    const error = `dispatch fetch error: ${err}`;
    console.warn(`[dispatch] ${error}`);
    return { dispatched: false, error };
  }
}
