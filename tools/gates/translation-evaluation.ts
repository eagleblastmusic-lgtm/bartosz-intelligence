import {
  validateLabControls,
  type LabControls,
} from '../../packages/core/src/registry/lab.js';
export const translationCriticalErrors = [
  'NEGATION_CHANGED',
  'NUMBER_CHANGED',
  'FABRICATED_FACT',
  'ASR_GUESSED',
  'MISSING_SEGMENT',
  'FABRICATED_TIMESTAMP',
] as const;
export type TranslationRating = {
  reviewer_id: string;
  blind_label: string;
  reviewed_at: string;
  scores: [number | null, number | null, number | null, number | null];
  critical_errors: (typeof translationCriticalErrors)[number][] | null;
};
export interface TranslationTrial {
  source_hash: string;
  variant: 'A' | 'B';
  repeat: number;
  request_hash: string;
  response_hash: string;
  request_id: string;
  provenance: 'REAL_PROVIDER' | 'FIXTURE';
  started_at: string;
  latency_ms: number;
  ai_repairs: number;
  quota_snapshot_ids: string[];
  ratings: TranslationRating[];
  files: {
    source: string;
    request: string;
    response: string;
    annotations: string;
  };
  annotations_hash: string;
}
export interface TranslationBenchmark {
  version: 'translation-benchmark:1';
  controls: LabControls;
  sources: {
    source_hash: string;
    stratum: 'SHORT' | 'MEDIUM' | 'LONG';
    language: string;
    cases: string[];
    repeats: 1 | 3;
  }[];
  trials: TranslationTrial[];
}
export interface VerifiedTranslationTrial {
  request_id: string;
  raw_valid: boolean;
  mapped_valid: boolean;
  complete: boolean;
  deterministic_repairs: string[];
  input_tokens: number | null;
  output_tokens: number | null;
  wire_bytes: number;
  canonical_bytes: number | null;
  missing_segments: number | null;
  duplicate_segments: boolean;
}
/** Verified measurements come from files, while all semantic labels come from humans. */
export function evaluateTranslation(
  review: TranslationBenchmark,
  measurements: VerifiedTranslationTrial[],
) {
  validateLabControls(review.controls);
  if (
    review.version !== 'translation-benchmark:1' ||
    !Array.isArray(review.sources) ||
    !Array.isArray(review.trials) ||
    review.trials.length > 300 ||
    measurements.length !== review.trials.length
  )
    throw new Error('INVALID_TRANSLATION_BENCHMARK');
  const sources = new Map(
    review.sources.map((source) => [source.source_hash, source]),
  );
  if (
    sources.size !== review.sources.length ||
    JSON.stringify(review.sources.map((source) => source.source_hash)) !==
      JSON.stringify(review.controls.source_hashes)
  )
    throw new Error('TRANSLATION_CORPUS_MISMATCH');
  const reasons = new Set<string>();
  if (sources.size < 24 || sources.size > 30)
    reasons.add('INSUFFICIENT_TRANSLATION_CORPUS');
  if (new Set(review.sources.map((source) => source.stratum)).size !== 3)
    reasons.add('MISSING_LENGTH_STRATUM');
  if (
    !review.sources.some((source) => source.language === 'en') ||
    !review.sources.some(
      (source) => source.language !== 'en' && source.language !== 'pl',
    )
  )
    reasons.add('MISSING_LANGUAGE_COVERAGE');
  const cases = new Set(review.sources.flatMap((source) => source.cases));
  for (const value of [
    'TECH_AI',
    'GENERAL',
    'ECON_GEO',
    'ASR',
    'NAMES',
    'NUMBERS',
    'NEGATION',
  ])
    if (!cases.has(value)) reasons.add('MISSING_TRANSLATION_CASE');
  if (!review.sources.some((source) => source.repeats === 3))
    reasons.add('REPEATS_NOT_MEASURED');
  for (const source of review.sources) {
    if (
      !['SHORT', 'MEDIUM', 'LONG'].includes(source.stratum) ||
      !source.language ||
      ![1, 3].includes(source.repeats) ||
      source.repeats > review.controls.repeats
    )
      throw new Error('INVALID_TRANSLATION_SOURCE_SCOPE');
  }
  const seen = new Set<string>(),
    requests = new Set<string>();
  const variants = {
    A: {
      scores: [] as number[],
      raw_valid: 0,
      mapped_valid: 0,
      complete: 0,
      unknown_usage: 0,
      known_input_tokens: 0,
      known_output_tokens: 0,
      ai_repairs: 0,
      deterministic_repaired: 0,
      wire_bytes: 0,
      canonical_bytes: 0,
      unknown_canonical_bytes: 0,
      latency_ms: [] as number[],
    },
    B: {
      scores: [] as number[],
      raw_valid: 0,
      mapped_valid: 0,
      complete: 0,
      unknown_usage: 0,
      known_input_tokens: 0,
      known_output_tokens: 0,
      ai_repairs: 0,
      deterministic_repaired: 0,
      wire_bytes: 0,
      canonical_bytes: 0,
      unknown_canonical_bytes: 0,
      latency_ms: [] as number[],
    },
  };
  let criticalErrors = 0,
    disagreements = 0,
    missingSegments = 0,
    unknownMissingSegments = 0,
    duplicateTrials = 0;
  const blindLabels = new Map<string, string>();
  review.trials.forEach((trial, index) => {
    const source = sources.get(trial.source_hash),
      m = measurements[index]!;
    const key = `${trial.source_hash}:${trial.variant}:${trial.repeat}`;
    if (
      !source ||
      !['A', 'B'].includes(trial.variant) ||
      !Number.isSafeInteger(trial.repeat) ||
      trial.repeat < 1 ||
      trial.repeat > source.repeats ||
      seen.has(key) ||
      requests.has(trial.request_id) ||
      !trial.request_id ||
      m.request_id !== trial.request_id ||
      !Number.isFinite(Date.parse(trial.started_at)) ||
      !Number.isFinite(trial.latency_ms) ||
      trial.latency_ms < 0 ||
      !Number.isSafeInteger(trial.ai_repairs) ||
      trial.ai_repairs < 0 ||
      trial.ai_repairs > 1 ||
      !['REAL_PROVIDER', 'FIXTURE'].includes(trial.provenance)
    )
      throw new Error('INVALID_TRANSLATION_TRIAL');
    seen.add(key);
    requests.add(trial.request_id);
    if (trial.provenance !== 'REAL_PROVIDER')
      reasons.add('REAL_PROVIDER_REQUIRED');
    if (
      trial.quota_snapshot_ids.length !== 3 ||
      new Set(trial.quota_snapshot_ids).size !== 3 ||
      trial.quota_snapshot_ids.some((id) => !id)
    )
      reasons.add('QUOTA_PROVENANCE_MISSING');
    const v = variants[trial.variant];
    v.raw_valid += Number(m.raw_valid);
    v.mapped_valid += Number(m.mapped_valid);
    v.complete += Number(m.complete);
    if (m.missing_segments === null) unknownMissingSegments++;
    else missingSegments += m.missing_segments;
    duplicateTrials += Number(m.duplicate_segments);
    if (!m.mapped_valid || !m.complete || m.duplicate_segments)
      reasons.add('TRANSLATION_VALIDATION_FAILED');
    v.deterministic_repaired += Number(m.deterministic_repairs.length > 0);
    v.ai_repairs += trial.ai_repairs;
    v.latency_ms.push(trial.latency_ms);
    v.wire_bytes += m.wire_bytes;
    if (m.canonical_bytes === null) v.unknown_canonical_bytes++;
    else v.canonical_bytes += m.canonical_bytes;
    for (const tokens of [m.input_tokens, m.output_tokens])
      if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 0))
        throw new Error('INVALID_TRANSLATION_USAGE');
    if (m.input_tokens === null || m.output_tokens === null) {
      v.unknown_usage++;
      reasons.add('ACTUAL_USAGE_UNKNOWN');
    }
    v.known_input_tokens += m.input_tokens ?? 0;
    v.known_output_tokens += m.output_tokens ?? 0;
    if (
      trial.ratings.length !== 2 ||
      !trial.ratings[0]?.reviewer_id ||
      !trial.ratings[1]?.reviewer_id ||
      trial.ratings[0].reviewer_id === trial.ratings[1].reviewer_id
    )
      reasons.add('INDEPENDENT_HUMAN_REVIEW_REQUIRED');
    for (const rating of trial.ratings) {
      if (
        !rating.blind_label ||
        ['A', 'B'].includes(rating.blind_label) ||
        !Number.isFinite(Date.parse(rating.reviewed_at)) ||
        Date.parse(rating.reviewed_at) < Date.parse(trial.started_at)
      )
        throw new Error('INVALID_BLIND_TRANSLATION_REVIEW');
      const blindKey = `${trial.source_hash}:${trial.repeat}:${rating.reviewer_id}:${rating.blind_label}`;
      if (
        blindLabels.has(blindKey) &&
        blindLabels.get(blindKey) !== trial.variant
      )
        throw new Error('BLIND_LABEL_COLLISION');
      blindLabels.set(blindKey, trial.variant);
      if (Array.isArray(rating.critical_errors)) {
        if (
          rating.critical_errors.some(
            (error) => !translationCriticalErrors.includes(error),
          ) ||
          new Set(rating.critical_errors).size !== rating.critical_errors.length
        )
          throw new Error('INVALID_TRANSLATION_HUMAN_LABEL');
        criticalErrors += rating.critical_errors.length;
      }
      if (
        !Array.isArray(rating.scores) ||
        rating.scores.length !== 4 ||
        !Array.isArray(rating.critical_errors)
      ) {
        reasons.add('HUMAN_LABELS_INCOMPLETE');
        continue;
      }
      if (rating.scores.some((score) => score === null)) {
        reasons.add('HUMAN_LABELS_INCOMPLETE');
        continue;
      }
      if (
        rating.scores.some(
          (score) => !Number.isInteger(score) || score! < 0 || score! > 4,
        ) ||
        rating.critical_errors.some(
          (error) => !translationCriticalErrors.includes(error),
        ) ||
        new Set(rating.critical_errors).size !== rating.critical_errors.length
      )
        throw new Error('INVALID_TRANSLATION_HUMAN_LABEL');
      v.scores.push(
        rating.scores.reduce<number>(
          (total, score, i) =>
            total + (score! * [0.4, 0.25, 0.2, 0.15][i]!) / 4,
          0,
        ),
      );
    }
    if (
      trial.ratings.length === 2 &&
      JSON.stringify({
        scores: trial.ratings[0]!.scores,
        errors: trial.ratings[0]!.critical_errors,
      }) !==
        JSON.stringify({
          scores: trial.ratings[1]!.scores,
          errors: trial.ratings[1]!.critical_errors,
        })
    )
      disagreements++;
  });
  for (const source of review.sources)
    for (const variant of ['A', 'B'])
      for (let repeat = 1; repeat <= source.repeats; repeat++)
        if (!seen.has(`${source.source_hash}:${variant}:${repeat}`))
          reasons.add('MISSING_PAIRED_TRIAL');
  if (criticalErrors) reasons.add('CRITICAL_TRANSLATION_ERROR');
  if (disagreements) reasons.add('HUMAN_DISAGREEMENT_REQUIRES_REVIEW');
  return {
    version: 'translation-evaluation:1',
    status: reasons.has('REAL_PROVIDER_REQUIRED')
      ? 'NOT_RUN'
      : reasons.has('CRITICAL_TRANSLATION_ERROR') ||
          reasons.has('TRANSLATION_VALIDATION_FAILED')
        ? 'FAIL'
        : reasons.has('INDEPENDENT_HUMAN_REVIEW_REQUIRED') ||
            reasons.has('HUMAN_LABELS_INCOMPLETE')
          ? 'AWAITING_HUMAN_REVIEW'
          : reasons.size
            ? 'FAIL'
            : 'PASS',
    sources: sources.size,
    trials: seen.size,
    variants,
    critical_errors: criticalErrors,
    human_disagreements: disagreements,
    missing_segments: missingSegments,
    trials_with_unknown_missing_segments: unknownMissingSegments,
    trials_with_duplicates: duplicateTrials,
    scope: structuredClone(review.controls),
    weights: [0.4, 0.25, 0.2, 0.15],
    reasons: [...reasons].sort(),
    cost: 'UNKNOWN',
    approval_published: false,
    // A benchmark report never grants eligibility or automatically promotes a profile.
    automatic_promotion: false,
  };
}
