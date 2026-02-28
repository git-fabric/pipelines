/**
 * MTTR metrics helper — appends incident + resolution records to git-steer-state.
 * The metrics/incidents.jsonl file tracks detect→dispatch→resolve timing.
 */

import { callTool } from './gateway.js';

export interface IncidentMetric {
  ts: string;
  pipeline: string;
  issue: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  autoDispatched: boolean;
  dispatchCount: number;
  prUrl?: string;
}

/**
 * Append an incident metric record to git-steer-state metrics/incidents.jsonl
 * Non-fatal — failure is logged but doesn't stop the pipeline.
 */
export async function recordIncident(metric: IncidentMetric): Promise<void> {
  const entry = JSON.stringify({ ...metric, ts: metric.ts || new Date().toISOString() });

  try {
    // Read current file or start fresh
    let current = '';
    try {
      const existing = (await callTool('git_get_file', {
        owner: 'ry-ops',
        repo: 'git-steer-state',
        path: 'metrics/incidents.jsonl',
        branch: 'main',
      })) as { content?: string };
      current = existing.content ?? '';
    } catch {
      // File doesn't exist yet — create it
    }

    await callTool('git_commit_push', {
      owner: 'ry-ops',
      repo: 'git-steer-state',
      branch: 'main',
      message: `metrics: incident recorded by ${metric.pipeline}`,
      files: [
        {
          path: 'metrics/incidents.jsonl',
          content: current ? `${current.trimEnd()}\n${entry}\n` : `${entry}\n`,
        },
      ],
    });
  } catch (err) {
    console.warn(`[metrics] failed to record incident (non-fatal):`, err);
  }
}
