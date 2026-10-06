import type { CapacityMeasurements } from './capacity-observation.js';
export const gateCCriteria = [
  'coverage_and_deduplication',
  'sustainable_capacity',
  'ordinary_24h_slo',
  'outage_and_reset_recovery',
  'normal_backlog_trend',
  'zero_paid_audit',
  'all_film_usefulness',
  'quality_cpu_integrity',
] as const;
export type GateCCriterion = (typeof gateCCriteria)[number];
export interface GateCProof {
  status: 'PASS' | 'FAIL' | 'UNKNOWN';
  evidence_ref: string | null;
}
export interface GateCInput {
  version: 'gate-c-input:1';
  basis: 'REAL_PRODUCTION' | 'SYNTHETIC';
  measurements: CapacityMeasurements;
  preregistration: {
    source_ids: string[];
    trace_days: number;
    calibration_days: number;
    observation_days: number;
    arrival_end_at: string;
    evidence_ref: string | null;
  };
  conservative_service_rate: {
    value: number | null;
    evidence_ref: string | null;
  };
  proofs: Record<GateCCriterion, GateCProof>;
  evidence_files?: { path: string; sha256: string }[];
}
