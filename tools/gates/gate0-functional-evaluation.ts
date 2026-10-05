import type { Gate0LiveObservation } from './transcript-bench-live.js';

export type FunctionalFetchObservation = Pick<
  Gate0LiveObservation,
  'video_id' | 'operation' | 'status' | 'attempt_number' | 'result'
>;

// Acquisition OK is insufficient: evaluate the frozen duration invariant as well.
// Never mutate the original rows or clamp genuine source timestamps.
export function evaluateGate0FunctionalCaptions(
  fetchObservations: readonly FunctionalFetchObservation[],
  eligibleDenominator: number,
  minimumSuccessRate: number,
) {
  const latest = new Map<string, FunctionalFetchObservation>();
  for (const row of fetchObservations) {
    if (row.operation !== 'fetch_track') continue;
    const previous = latest.get(row.video_id);
    if (!previous || row.attempt_number > previous.attempt_number)
      latest.set(row.video_id, row);
  }
  const acquisitionSuccesses = [...latest.values()].filter(
    (row) => row.status === 'OK',
  );
  const durationConflicts = acquisitionSuccesses
    .filter((row) => row.result?.within_duration === false)
    .map((row) => row.video_id);
  const durationUnknown = acquisitionSuccesses
    .filter((row) => typeof row.result?.within_duration !== 'boolean')
    .map((row) => row.video_id);
  const successes = acquisitionSuccesses.filter(
    (row) =>
      row.result?.within_duration === true &&
      row.result?.is_translated_track === false,
  ).length;
  const successRate =
    eligibleDenominator > 0 ? successes / eligibleDenominator : 0;
  return {
    eligible_denominator: eligibleDenominator,
    acquisition_successes: acquisitionSuccesses.length,
    functional_successes: successes,
    functional_success_rate: successRate,
    duration_conflicts: durationConflicts,
    duration_unknown: durationUnknown,
    status:
      eligibleDenominator <= 0 || durationUnknown.length > 0
        ? ('INCONCLUSIVE' as const)
        : successRate >= minimumSuccessRate
          ? ('PASS' as const)
          : ('FAIL' as const),
  };
}
