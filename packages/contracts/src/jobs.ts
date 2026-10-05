export const jobStates = [
  'PENDING',
  'LEASED',
  'RUNNING',
  'SUCCEEDED',
  'DEFERRED',
  'RETRY_WAIT',
  'BLOCKED',
  'FAILED',
] as const;
export type JobState = (typeof jobStates)[number];
export const taskTypes = [
  'DISCOVER',
  'RECONCILE',
  'FETCH_TRANSCRIPT',
  'NORMALIZE',
  'ANALYZE',
  'TRANSLATE',
  'HISTORICAL_COMPARE',
  'REPROCESS',
  'PROJECT',
  'EXPORT_DAY',
  'BACKUP',
] as const;
export type TaskType = (typeof taskTypes)[number];
export interface QueueSignal {
  job_id: string;
  fencing_hint: number | null;
  task_type: TaskType;
}
export interface LeaseToken {
  job_id: string;
  lease_owner: string;
  fencing_token: number;
  lease_until: string;
}
export interface JobInput {
  item_id: string | null;
  source_id: string | null;
  task_type: TaskType;
  input_revision: string;
  profile_revision: string;
  prompt_snapshot_id: string | null;
  routing_policy_version: string;
  wire_schema_version: string | null;
  canonical_schema_version: string | null;
  enrichment_version: string | null;
  explicit_run_nonce: string;
  arrival_origin_at: string;
  origin_kind: 'NEW' | 'BACKFILL' | 'MANUAL' | 'INTEGRITY';
  payload: Record<string, unknown>;
  priority: number;
  due_at: string;
}
export type JobRecord = JobInput & {
  job_id: string;
  owner_id: string;
  dedup_key: string;
  state: JobState;
  reason_code: string | null;
  attempt_count: number;
  lease_owner: string | null;
  lease_until: string | null;
  fencing_token: number;
  result_candidate_id: string | null;
  created_at: string;
  updated_at: string;
};
