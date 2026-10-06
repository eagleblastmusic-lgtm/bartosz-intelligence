export type CapacityEligibility =
  | 'ORDINARY'
  | 'NO_CAPTIONS'
  | 'NATURAL_UNREACHABLE'
  | 'LIVE'
  | 'LONG_INPUT'
  | 'LOCAL_STT'
  | 'UNKNOWN';
export interface CapacityCase {
  work_item_id: string;
  item_id: string;
  source_id: string;
  origin_kind: 'NEW' | 'BACKFILL' | 'PROBE';
  published_at: string | null;
  arrival_origin_at: string;
  eligibility: CapacityEligibility;
  eligibility_recorded_at: string | null;
  eligibility_ref: string | null;
  analysis_started_at: string | null;
  accepted_complete_at: string | null;
  accepted_effect_id: string | null;
  source_execution_ref: string | null;
}
export interface CapacityDay {
  date: string;
  config_hash: string;
  phase: 'CALIBRATION' | 'NORMAL' | 'SATURATED' | 'OUTAGE' | 'RECOVERY';
  ordinary_open_new: number | null;
  ordinary_open_backfill: number | null;
  continuous_representative_backlog: boolean;
  actual_quota_windows_observed: boolean;
  real_source_retrieval: boolean;
  qualified_pipeline: boolean;
  evidence_ref: string | null;
  enumeration_complete: boolean;
}
export interface CapacityMeasurements {
  version: 'capacity-measurements:1';
  config_hash: string;
  timezone: 'Europe/Warsaw';
  start_date: string;
  end_date_exclusive: string;
  sampled_at: string;
  cases: CapacityCase[];
  days: CapacityDay[];
  excess_backlog: number | null;
}
