import type { SemanticProfile } from '../../packages/core/src/ai/semantic-profile.js';
export interface PilotScope {
  provider: string;
  model: string;
  prompt_hash: string;
  wire_hash: string;
  canonical_schema_hash: string;
  enrichment_version: string;
  normalizer_version: string;
  quality_scope: string;
  semantic_profile?: SemanticProfile;
}
export interface PilotFilm {
  files?: {
    source: string;
    manifest: string;
    candidate: string | null;
    canonical: string | null;
    annotations: string;
    response: string;
  };
  video_id: string;
  source_hash: string;
  manifest_hash: string;
  candidate_hash: string | null;
  canonical_hash: string | null;
  annotations_hash: string;
  annotations_frozen_at: string;
  provider_started_at: string;
  cases: string[];
  canonical_element_ids: string[];
  elements: {
    element_id: string;
    supported: boolean | null;
    anchor_valid: boolean | null;
    severe_hallucination: boolean | null;
  }[];
  important_claims: { claim_id: string; matched_element_ids: string[] }[];
  human: {
    reviewer_id: string;
    independent_reviewer_id: string | null;
    reviewed_at: string;
    disagreements_resolved: boolean;
    summary_coverage: boolean | null;
    stance_usage: boolean | null;
    prediction_qualifiers: boolean | null;
    entity_alias_ambiguity: boolean | null;
  };
  provider: {
    provenance: 'REAL_PROVIDER' | 'FIXTURE';
    request_id: string;
    response_hash: string;
    quota_snapshot_ids: string[];
    usage_logged: boolean;
    input_tokens: number | null;
    output_tokens: number | null;
    completion: string;
    raw_json_valid: boolean;
    wire_valid: boolean;
    canonical_valid: boolean;
    source_complete: boolean;
    deterministic_repairs: string[];
    ai_repairs: number;
    latency_ms: number;
    cpu_ms: number | null;
  };
}
export interface PilotReview {
  version: 'ai-pilot-review:1';
  scope: PilotScope;
  films: PilotFilm[];
}
const criticalCases = [
  'NEGATION',
  'CONDITION',
  'NUMBER',
  'REPORTED_SPEECH',
  'STANCE_USAGE',
  'PREDICTION_HORIZON',
  'ENTITY_AMBIGUITY',
  'ASR_DIFFICULT',
];
const hash = (value: string) => /^[a-f0-9]{64}$/.test(value);
export function binomialMetric(successes: number, n: number) {
  if (n === 0) return { successes, n, rate: null, ci95: null };
  const z = 1.959963984540054,
    z2 = z * z,
    p = successes / n,
    denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return {
    successes,
    n,
    rate: p,
    ci95: [Math.max(0, centre - half), Math.min(1, centre + half)],
  };
}
// Human support/recall labels remain ground truth. This evaluator does not
// perform entailment inference, make provider calls or publish model approvals.
export function evaluateAiPilot(
  review: PilotReview,
  level: 'STAGE_03_PILOT' | 'FULL_GATE_AI' = 'STAGE_03_PILOT',
) {
  if (
    review.version !== 'ai-pilot-review:1' ||
    !Array.isArray(review.films) ||
    review.films.length > 100 ||
    !review.scope ||
    !hash(review.scope.prompt_hash) ||
    !hash(review.scope.wire_hash) ||
    !hash(review.scope.canonical_schema_hash) ||
    !hash(review.scope.quality_scope) ||
    !review.scope.provider ||
    !review.scope.model ||
    review.scope.enrichment_version !== '1.0' ||
    review.scope.normalizer_version !== 'source-normalizer:1'
  )
    throw new Error('INVALID_PILOT_SCOPE');
  const reasons = new Set<string>(),
    videos = new Set<string>(),
    requests = new Set<string>(),
    cases = new Set<string>();
  let supported = 0,
    elements = 0,
    anchors = 0,
    important = 0,
    recalled = 0,
    severe = 0,
    rawValid = 0,
    wireValid = 0,
    canonicalValid = 0,
    repairs = 0,
    aiRepairs = 0,
    knownInput = 0,
    knownOutput = 0,
    unknownUsage = 0;
  const perFilm: unknown[] = [];
  for (const film of review.films) {
    if (
      !/^[A-Za-z0-9_-]{11}$/.test(film.video_id) ||
      videos.has(film.video_id) ||
      ![
        film.source_hash,
        film.manifest_hash,
        film.candidate_hash,
        film.canonical_hash,
        film.annotations_hash,
        film.provider.response_hash,
      ]
        .filter((value) => value !== null)
        .every(hash)
    )
      throw new Error('INVALID_PILOT_IDENTITY');
    videos.add(film.video_id);
    if (!film.provider.request_id || requests.has(film.provider.request_id))
      throw new Error('DUPLICATE_PILOT_REQUEST');
    requests.add(film.provider.request_id);
    if (
      !Array.isArray(film.cases) ||
      film.cases.some((value) => !criticalCases.includes(value))
    )
      throw new Error('INVALID_PILOT_CASE');
    film.cases.forEach((value) => cases.add(value));
    if (
      !Number.isFinite(Date.parse(film.annotations_frozen_at)) ||
      !Number.isFinite(Date.parse(film.provider_started_at)) ||
      Date.parse(film.annotations_frozen_at) >
        Date.parse(film.provider_started_at)
    )
      reasons.add('ANNOTATIONS_NOT_FROZEN_BEFORE_REQUEST');
    if (
      !film.human.reviewer_id ||
      !Number.isFinite(Date.parse(film.human.reviewed_at)) ||
      Date.parse(film.human.reviewed_at) <
        Date.parse(film.provider_started_at) ||
      !film.human.disagreements_resolved ||
      [
        film.human.summary_coverage,
        film.human.stance_usage,
        film.human.prediction_qualifiers,
        film.human.entity_alias_ambiguity,
      ].some((value) => value !== true)
    )
      reasons.add('HUMAN_REVIEW_INCOMPLETE_OR_FAILED');
    if (
      film.cases.length &&
      (!film.human.independent_reviewer_id ||
        film.human.independent_reviewer_id === film.human.reviewer_id)
    )
      reasons.add('INDEPENDENT_CRITICAL_REVIEW_REQUIRED');
    const ids = new Set(film.canonical_element_ids),
      byId = new Map(
        film.elements.map((element) => [element.element_id, element]),
      );
    if (
      ids.size !== film.canonical_element_ids.length ||
      ids.size !== byId.size ||
      byId.size !== film.elements.length ||
      [...ids].some((id) => !id || !byId.has(id))
    )
      throw new Error('INCOMPLETE_PILOT_ELEMENT_LABELS');
    if (!ids.size) reasons.add('EMPTY_PILOT_OUTPUT');
    for (const element of film.elements) {
      elements++;
      if (element.supported === true) supported++;
      if (element.anchor_valid === true) anchors++;
      if (element.severe_hallucination === true) severe++;
      if (
        [
          element.supported,
          element.anchor_valid,
          element.severe_hallucination,
        ].some((value) => typeof value !== 'boolean')
      )
        reasons.add('UNKNOWN_HUMAN_LABEL');
    }
    const claims = new Set<string>();
    let filmRecall = 0;
    for (const claim of film.important_claims) {
      if (
        !claim.claim_id ||
        claims.has(claim.claim_id) ||
        new Set(claim.matched_element_ids).size !==
          claim.matched_element_ids.length ||
        claim.matched_element_ids.some((id) => !ids.has(id))
      )
        throw new Error('INVALID_PILOT_CLAIM_MAPPING');
      claims.add(claim.claim_id);
      important++;
      if (
        claim.matched_element_ids.some((id) => byId.get(id)!.supported === true)
      ) {
        recalled++;
        filmRecall++;
      }
    }
    const provider = film.provider;
    if (
      !['REAL_PROVIDER', 'FIXTURE'].includes(provider.provenance) ||
      [
        provider.usage_logged,
        provider.raw_json_valid,
        provider.wire_valid,
        provider.canonical_valid,
        provider.source_complete,
      ].some((value) => typeof value !== 'boolean')
    )
      throw new Error('INVALID_PILOT_MEASUREMENT');
    if (provider.provenance !== 'REAL_PROVIDER')
      reasons.add('REAL_PROVIDER_REQUIRED');
    if (
      provider.completion !== 'OK' ||
      !provider.wire_valid ||
      !provider.canonical_valid ||
      !provider.source_complete
    )
      reasons.add('PROVIDER_OR_DETERMINISTIC_VALIDATION_FAILED');
    if (
      !provider.usage_logged ||
      provider.quota_snapshot_ids.length !== 3 ||
      new Set(provider.quota_snapshot_ids).size !== 3 ||
      provider.quota_snapshot_ids.some((id) => !id)
    )
      reasons.add('QUOTA_USAGE_PROVENANCE_MISSING');
    if (
      !Number.isSafeInteger(provider.ai_repairs) ||
      provider.ai_repairs < 0 ||
      provider.ai_repairs > 1 ||
      !Number.isFinite(provider.latency_ms) ||
      provider.latency_ms < 0 ||
      (provider.cpu_ms !== null &&
        (!Number.isFinite(provider.cpu_ms) || provider.cpu_ms < 0)) ||
      provider.deterministic_repairs.some(
        (rule) => !['DR1', 'DR2', 'DR3', 'DR4'].includes(rule),
      )
    )
      throw new Error('INVALID_PILOT_MEASUREMENT');
    for (const value of [provider.input_tokens, provider.output_tokens])
      if (value !== null && (!Number.isSafeInteger(value) || value < 0))
        throw new Error('INVALID_PILOT_USAGE');
    knownInput += provider.input_tokens ?? 0;
    knownOutput += provider.output_tokens ?? 0;
    if (provider.input_tokens === null || provider.output_tokens === null)
      unknownUsage++;
    rawValid += Number(provider.raw_json_valid);
    wireValid += Number(provider.wire_valid);
    canonicalValid += Number(provider.canonical_valid);
    repairs += Number(provider.deterministic_repairs.length > 0);
    aiRepairs += provider.ai_repairs;
    perFilm.push({
      video_id: film.video_id,
      elements: ids.size,
      important_claims: claims.size,
      recalled: filmRecall,
      latency_ms: provider.latency_ms,
      cpu_ms: provider.cpu_ms,
    });
  }
  const minimumFilms = level === 'STAGE_03_PILOT' ? 12 : 30,
    minimumClaims = level === 'STAGE_03_PILOT' ? 40 : 100;
  if (videos.size < minimumFilms || important < minimumClaims)
    reasons.add('INSUFFICIENT_CORPUS');
  for (const tag of criticalCases)
    if (!cases.has(tag)) reasons.add('MISSING_CRITICAL_CASES');
  const precision = binomialMetric(supported, elements),
    recall = binomialMetric(recalled, important),
    anchorValidation = binomialMetric(anchors, elements);
  if (precision.rate === null || precision.rate < 0.95)
    reasons.add('SUPPORTED_PRECISION_BELOW_95_PERCENT');
  if (recall.rate === null || recall.rate < 0.85)
    reasons.add('IMPORTANT_RECALL_BELOW_85_PERCENT');
  if (anchorValidation.rate !== 1)
    reasons.add('ANCHOR_VALIDATION_BELOW_100_PERCENT');
  if (severe !== 0) reasons.add('SEVERE_HALLUCINATION');
  const status = reasons.has('REAL_PROVIDER_REQUIRED')
    ? 'NOT_RUN'
    : reasons.size
      ? 'FAIL'
      : 'PASS';
  return {
    version: 'ai-pilot-evaluation:1',
    level,
    status,
    scope: structuredClone(review.scope),
    films: videos.size,
    minimum_films: minimumFilms,
    minimum_important_claims: minimumClaims,
    precision,
    recall,
    anchor_validation: anchorValidation,
    severe_hallucinations: severe,
    confidence_interval_method: 'WILSON_95_ELEMENT_LEVEL_NOT_CLUSTER_ADJUSTED',
    raw_valid: rawValid,
    wire_valid: wireValid,
    canonical_valid: canonicalValid,
    deterministic_repaired: repairs,
    ai_repair_requests: aiRepairs,
    usage: {
      known_input_tokens: knownInput,
      known_output_tokens: knownOutput,
      films_with_unknown_usage: unknownUsage,
    },
    reasons: [...reasons].sort(),
    per_film: perFilm,
    approval_published: false,
    full_gate_ai: level === 'FULL_GATE_AI' ? status : 'NOT_RUN',
  };
}
