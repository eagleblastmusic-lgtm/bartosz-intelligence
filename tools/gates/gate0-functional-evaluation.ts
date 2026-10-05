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

export interface SourceFidelityProof {
  video_id: string;
  candidate_request_id: string;
  status: string;
  original_payload_hash_match: boolean;
  original_cue_count_match: boolean;
  all_cue_max_delta_ms: number;
  all_cue_text_hashes_equal: boolean;
}

// Criteria v2: preserve v1 above. Source drift and source metadata inconsistency
// are distinct. A duration warning never licenses clamping or missing proof.
export function evaluateGate0SourceFaithfulCaptions(
  rows: readonly (FunctionalFetchObservation & { request_id: string })[],
  proofs: readonly SourceFidelityProof[],
  eligibleDenominator: number,
  minimumSuccessRate: number,
  sourceToleranceMs: number,
) {
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.operation !== 'fetch_track') continue;
    if (
      !latest.has(row.video_id) ||
      latest.get(row.video_id)!.attempt_number < row.attempt_number
    )
      latest.set(row.video_id, row);
  }
  const proofById = new Map(proofs.map((proof) => [proof.video_id, proof]));
  const successes: string[] = [];
  const sourceOverruns: string[] = [];
  const missingOrInvalidProof: string[] = [];
  for (const row of latest.values()) {
    if (row.status !== 'OK') continue;
    const proof = proofById.get(row.video_id);
    if (
      !proof ||
      proof.candidate_request_id !== row.request_id ||
      proof.status !== 'PASS' ||
      !proof.original_payload_hash_match ||
      !proof.original_cue_count_match ||
      !proof.all_cue_text_hashes_equal ||
      !Number.isFinite(proof.all_cue_max_delta_ms) ||
      proof.all_cue_max_delta_ms < 0 ||
      proof.all_cue_max_delta_ms > sourceToleranceMs ||
      typeof row.result?.within_duration !== 'boolean'
    ) {
      missingOrInvalidProof.push(row.video_id);
      continue;
    }
    if (row.result?.is_translated_track !== false) continue;
    successes.push(row.video_id);
    if (row.result.within_duration === false) sourceOverruns.push(row.video_id);
  }
  const rate =
    eligibleDenominator > 0 ? successes.length / eligibleDenominator : 0;
  return {
    criteria_version: 'gate0-criteria-v2',
    functional_successes: successes.length,
    eligible_denominator: eligibleDenominator,
    functional_success_rate: rate,
    source_duration_overruns: sourceOverruns,
    missing_or_invalid_source_proof: missingOrInvalidProof,
    status:
      missingOrInvalidProof.length || eligibleDenominator <= 0
        ? ('INCONCLUSIVE' as const)
        : rate >= minimumSuccessRate
          ? ('PASS' as const)
          : ('FAIL' as const),
  };
}
