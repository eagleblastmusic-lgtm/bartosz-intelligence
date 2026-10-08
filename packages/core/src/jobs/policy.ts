import type { JobState, JobInput } from '../../../contracts/src/jobs.js';
import { sha256 } from '../auth/crypto.js';
// Both candidate selection and the atomic lease use the same immutable route.
// The two placeholders must be bound to the requested execution location.
export const runtimeAdmissionPredicate = `
  (routing_policy_version NOT IN ('local-primary-1','local-source-correction:1') OR ?='local')
  AND (routing_policy_version NOT IN ('pipeline-selector:1','optional-selector:1')
    OR json_extract(payload_json,'$.snapshot.settings.runtime')=?)`;
export async function jobDedup(owner: string, input: JobInput) {
  return sha256(
    JSON.stringify([
      owner,
      input.task_type,
      input.item_id,
      input.source_id,
      input.input_revision,
      input.profile_revision,
      input.prompt_snapshot_id,
      input.wire_schema_version,
      input.canonical_schema_version,
      input.enrichment_version,
      input.explicit_run_nonce,
    ]),
  );
}
const transitions: Record<JobState, readonly JobState[]> = {
  PENDING: ['LEASED'],
  LEASED: ['RUNNING', 'RETRY_WAIT'],
  RUNNING: ['SUCCEEDED', 'DEFERRED', 'RETRY_WAIT', 'BLOCKED', 'FAILED'],
  SUCCEEDED: [],
  DEFERRED: ['PENDING'],
  RETRY_WAIT: ['PENDING'],
  BLOCKED: ['PENDING'],
  FAILED: ['PENDING'],
};
export function canTransition(from: JobState, to: JobState) {
  return transitions[from].includes(to);
}
export function retryDisposition(
  code: 'TRANSIENT' | 'QUOTA' | 'AUTH' | 'INVALID_INPUT',
  attempt: number,
  now: Date,
  random = Math.random,
  resetAt?: string,
) {
  if (code === 'AUTH' || code === 'INVALID_INPUT')
    return {
      state: 'BLOCKED' as const,
      due_at: now.toISOString(),
      reason: code,
    };
  if (code === 'QUOTA') {
    if (
      !resetAt ||
      !Number.isFinite(Date.parse(resetAt)) ||
      Date.parse(resetAt) <= now.getTime()
    )
      throw new Error('RESET_REQUIRED');
    return { state: 'DEFERRED' as const, due_at: resetAt, reason: 'QUOTA' };
  }
  if (!Number.isInteger(attempt) || attempt < 1)
    throw new Error('INVALID_ATTEMPT');
  if (attempt > 4)
    return {
      state: 'DEFERRED' as const,
      due_at: new Date(now.getTime() + 21600000).toISOString(),
      reason: 'RETRY_BUDGET_EXHAUSTED',
    };
  const jitter = random();
  if (jitter < 0 || jitter >= 1) throw new Error('INVALID_JITTER');
  return {
    state: 'RETRY_WAIT' as const,
    due_at: new Date(
      now.getTime() + jitter * [60000, 300000, 1200000, 3600000][attempt - 1]!,
    ).toISOString(),
    reason: 'TRANSIENT',
  };
}
export function fairJobOrder<
  T extends {
    origin_kind: string;
    priority: number;
    arrival_origin_at: string;
    job_id: string;
    task_type: string;
  },
>(rows: T[], slots: number, now: Date): T[] {
  if (slots < 1) return [];
  const integrity = rows.filter((row) =>
    ['DISCOVER', 'RECONCILE', 'BACKUP'].includes(row.task_type),
  );
  const rest = rows.filter((row) => !integrity.includes(row));
  const score = (row: T) =>
    row.priority +
    Math.min(
      20,
      Math.floor((now.getTime() - Date.parse(row.arrival_origin_at)) / 3600000),
    );
  const sort = (a: T, b: T) =>
    score(b) - score(a) ||
    a.arrival_origin_at.localeCompare(b.arrival_origin_at) ||
    a.job_id.localeCompare(b.job_id);
  const selected = integrity.sort(sort).slice(0, slots);
  const remaining = slots - selected.length;
  if (!remaining) return selected;
  const backfill = rest
    .filter((row) => row.origin_kind === 'BACKFILL')
    .sort(sort)
    .slice(0, Math.ceil(remaining * 0.2));
  return [
    ...selected,
    ...backfill,
    ...rest
      .filter((row) => !backfill.includes(row))
      .sort(sort)
      .slice(0, remaining - backfill.length),
  ];
}
