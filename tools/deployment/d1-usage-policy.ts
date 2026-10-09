export interface UsageSample {
  observed_at: string;
  start_utc: string;
  state: string;
  account_rows_read: number | null;
  account_rows_written: number | null;
}
/** Analytics is delayed usage, never an exact remaining-quota counter. */
export function d1UsagePolicy(sample: UsageSample, now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error('INVALID_D1_CLOCK');
  const age = now.getTime() - Date.parse(sample.observed_at);
  if (
    sample.state !== 'MEASURED_ANALYTICS' ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 900000 ||
    sample.start_utc !== now.toISOString().slice(0, 10) + 'T00:00:00.000Z' ||
    !Number.isFinite(sample.account_rows_read) ||
    !Number.isFinite(sample.account_rows_written) ||
    sample.account_rows_read! < 0 ||
    sample.account_rows_written! < 0
  )
    return {
      state: 'UNKNOWN' as const,
      noncritical_admitted: false,
      exact_remaining_quota: null,
    };
  const utilization = Math.max(
    sample.account_rows_read! / 5000000,
    sample.account_rows_written! / 100000,
  );
  return {
    state:
      utilization >= 1
        ? ('EXHAUSTED' as const)
        : utilization >= 0.8
          ? ('RESERVE_CRITICAL_CAPACITY' as const)
          : ('WITHIN_OBSERVED_BUDGET' as const),
    noncritical_admitted: utilization < 0.8,
    exact_remaining_quota: null,
  };
}
