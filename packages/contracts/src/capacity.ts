export const capacityMetricNames = [
  'arrival_rate',
  'service_rate',
  'capacity_headroom',
  'oldest_eligible_job_age',
  'p50_time_to_analysis',
  'p95_time_to_analysis',
  'backlog_growth_rate',
  'estimated_drain_time',
] as const;
export type CapacityMetricName = (typeof capacityMetricNames)[number];
export interface CapacityMetric {
  value: number | null;
  unit: 'ITEMS_PER_DAY' | 'FRACTION' | 'SECONDS' | 'DAYS';
  status: 'UNKNOWN' | 'MEASURED' | 'NOT_DRAINING';
  reason: string | null;
  n: number;
}
export interface CapacitySnapshot {
  version: 'capacity:1';
  sampled_at: string;
  gate_c_status:
    | 'NOT_RUN'
    | 'OBSERVING'
    | 'NOT_YET_MATURE'
    | 'PASS'
    | 'FAIL'
    | 'INCONCLUSIVE';
  measurement_window: { start: string; end: string } | null;
  eligibility_status: 'UNKNOWN' | 'CLASSIFIED';
  completed: number | null;
  open: number | null;
  over_24h: number | null;
  metrics: Record<CapacityMetricName, CapacityMetric>;
}
