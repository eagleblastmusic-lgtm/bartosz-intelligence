/** Account limits reset in UTC; material dates remain Europe/Warsaw. Estimates
 * never count as provider/CPU qualification. Unknown/stale telemetry stops work. */
export interface FreeTranscriptObservation {
  sampled_at: string;
  quota_date_utc: string;
  plan: 'FREE' | 'PAID' | 'UNKNOWN';
  source_qualification: 'PASS' | 'BLOCKED' | 'UNKNOWN';
  complete_pipeline_cpu_p99_ms: number | null;
  workers_requests: number;
  d1_rows_read: number;
  d1_rows_written: number;
  queue_operations: number;
}
export function freeTranscriptAdmission(
  observation: FreeTranscriptObservation | null,
  now: Date,
) {
  if (
    !observation ||
    observation.plan !== 'FREE' ||
    observation.source_qualification !== 'PASS'
  )
    return {
      available: false,
      reason: 'UNQUALIFIED_FREE_REMOTE_SOURCE',
      additional_monthly_cost_pln: 0 as const,
    };
  const age = now.getTime() - Date.parse(observation.sampled_at);
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    age > 600000 ||
    observation.quota_date_utc !== now.toISOString().slice(0, 10)
  )
    return {
      available: false,
      reason: 'FREE_TELEMETRY_UNKNOWN_OR_STALE',
      additional_monthly_cost_pln: 0 as const,
    };
  const cpu = observation.complete_pipeline_cpu_p99_ms;
  if (cpu === null || !Number.isFinite(cpu) || cpu < 0 || cpu > 8)
    return {
      available: false,
      reason: 'FREE_PIPELINE_CPU_NOT_QUALIFIED',
      additional_monthly_cost_pln: 0 as const,
    };
  const limits = {
    workers_requests: 80000,
    d1_rows_read: 4000000,
    d1_rows_written: 80000,
    queue_operations: 8000,
  };
  for (const key of Object.keys(limits) as (keyof typeof limits)[])
    if (
      !Number.isSafeInteger(observation[key]) ||
      observation[key] < 0 ||
      observation[key] >= limits[key]
    )
      return {
        available: false,
        reason: 'FREE_CAPACITY_PAUSED',
        additional_monthly_cost_pln: 0 as const,
      };
  return {
    available: true,
    reason: null,
    additional_monthly_cost_pln: 0 as const,
  };
}
