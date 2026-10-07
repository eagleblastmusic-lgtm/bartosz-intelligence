import type { CapacitySnapshot } from './capacity.js';
import type { DailyExportStatus } from './drive.js';
export interface SystemSummary {
  sampled_at: string;
  paid_services_enabled: false;
  ai_profile: string;
  transcript_runtime: string;
  daily_exports?: DailyExportStatus;
  workers: {
    worker_id: string;
    availability: string;
    heartbeat_at: string;
    online_until?: string;
    runtime?: string;
  }[];
  durable_jobs: {
    state: string;
    count: number;
    task_type?: string;
    origin_kind?: string;
    oldest_arrival_origin_at?: string | null;
  }[];
  quota: {
    provider: string;
    bucket: string;
    remaining: number | null;
    freshness: string;
    limit_value?: number | null;
    used_value?: number | null;
    reset_at?: string | null;
    sampled_at?: string;
    expires_at?: string;
    source?: string;
  }[];
  provider_health?: {
    provider: string;
    runtime: string;
    state: string;
    sampled_at: string;
    freshness: string;
  }[];
  source_coverage?: {
    source_id: string;
    last_attempt_at: string | null;
    last_success_at: string | null;
    last_complete_window_end: string | null;
  }[];
  recent_discovery_scans?: {
    scan_id: string;
    source_id: string;
    coverage: string;
    enumerated_count: number;
    started_at: string;
    completed_at: string | null;
    window_start: string;
    window_end: string;
  }[];
  capacity_metrics?: CapacitySnapshot;
  capacity?: {
    arrival_count: number;
    accepted_count: number;
    open_count: number;
    oldest_open_arrival_origin_at: string | null;
  };
  job_reasons?: {
    state: string;
    task_type: string;
    origin_kind: string;
    reason_code: string | null;
    count: number;
    oldest_arrival_origin_at: string;
    next_due_at: string;
    attempts: number;
  }[];
  usage?: {
    requests: number;
    known_input_tokens: number;
    known_output_tokens: number;
    known_total_tokens: number;
    unknown_usage_count: number;
    latest_observed_at: string | null;
  };
  pipeline_profiles?: {
    profile_id: string;
    revision: number;
    integrity: string;
    provider_id?: string;
    model?: string;
    freshness?: string;
    eligibility_expires_at?: string;
    quality_approval_count?: number;
  }[];
  registry_versions?: {
    published_prompts: { prompt_id: string; version: number; status: string }[];
    wire: string;
    canonical: string;
    enrichment: string;
  };
  transcript_coverage?: {
    denominator: number;
    usable_source: number;
    cohort: string;
    provider_success: { value: null; status: string; reason: string };
  };
  backup?: { last_verified_at: string | null };
  outbox?: { pending: number; oldest_due_at: string | null };
  costs?: {
    status: string;
    actual_external_cost: number | null;
    external_cost_status: string;
  };
}
