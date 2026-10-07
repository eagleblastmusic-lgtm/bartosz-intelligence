import { it, expect } from 'vitest';
import {
  evaluateTranslation,
  type TranslationBenchmark,
  type VerifiedTranslationTrial,
} from '../../tools/gates/translation-evaluation.js';
import type { LabControls } from '../../packages/core/src/registry/lab.js';
function fixture() {
  const base = {
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    model_revision: 1,
    prompt_hash: 'a'.repeat(64),
    wire_hash: 'b'.repeat(64),
    canonical_hash: 'c'.repeat(64),
    reasoning: 'low',
    max_output_tokens: 128,
    seed: null,
  };
  const sources: TranslationBenchmark['sources'] = Array.from(
    { length: 24 },
    (_, i) => ({
      source_hash: i.toString(16).padStart(64, '0'),
      stratum: (['SHORT', 'MEDIUM', 'LONG'] as const)[i % 3]!,
      language: i === 23 ? 'de' : 'en',
      cases:
        i === 0
          ? [
              'TECH_AI',
              'GENERAL',
              'ECON_GEO',
              'ASR',
              'NAMES',
              'NUMBERS',
              'NEGATION',
            ]
          : [],
      repeats: i === 0 ? 3 : 1,
    }),
  );
  const controls: LabControls = {
    version: 'lab-controls:1',
    mode: 'PROMPT_AB',
    source_hashes: sources.map((s) => s.source_hash),
    repeats: 3,
    variants: [
      { ...base, id: 'A' },
      { ...base, id: 'B', prompt_hash: 'e'.repeat(64) },
    ],
    confounders: ['SEED_UNAVAILABLE', 'PROVIDER_NONDETERMINISM'],
  };
  const trials: TranslationBenchmark['trials'] = sources.flatMap((source) =>
    (['A', 'B'] as const).flatMap((variant) =>
      Array.from({ length: source.repeats }, (_, i) => ({
        source_hash: source.source_hash,
        variant,
        repeat: i + 1,
        request_hash: 'a'.repeat(64),
        response_hash: 'a'.repeat(64),
        annotations_hash: 'a'.repeat(64),
        request_id: `${source.source_hash}:${variant}:${i}`,
        provenance: 'FIXTURE' as const,
        started_at: '2026-10-07T10:00:00Z',
        latency_ms: 123,
        ai_repairs: 0,
        quota_snapshot_ids: ['rpm', 'rpd', 'tpm'],
        ratings: ['human-a', 'human-b'].map((reviewer_id) => ({
          reviewer_id,
          blind_label: variant === 'A' ? 'sample-17' : 'sample-93',
          reviewed_at: '2026-10-07T11:00:00Z',
          scores: [4, 4, 4, 4] as [number, number, number, number],
          critical_errors: [],
        })),
        files: {
          source: 'fixture',
          request: 'fixture',
          response: 'fixture',
          annotations: 'fixture',
        },
      })),
    ),
  );
  const measurements: VerifiedTranslationTrial[] = trials.map((trial) => ({
    request_id: trial.request_id,
    raw_valid: true,
    mapped_valid: true,
    complete: true,
    deterministic_repairs: [],
    input_tokens: 100,
    output_tokens: 50,
    wire_bytes: 200,
    canonical_bytes: 300,
    missing_segments: 0,
    duplicate_segments: false,
  }));
  const review: TranslationBenchmark = {
    version: 'translation-benchmark:1',
    controls,
    sources,
    trials,
  };
  return { review, measurements };
}
it('fixture perfection does not qualify a provider or publish approval', () => {
  const { review, measurements } = fixture();
  const report = evaluateTranslation(review, measurements);
  expect(report).toMatchObject({
    status: 'NOT_RUN',
    sources: 24,
    trials: 52,
    automatic_promotion: false,
    approval_published: false,
    cost: 'UNKNOWN',
  });
  expect(report.variants.A.scores).toHaveLength(52);
  expect(
    report.variants.A.scores.every((score) => Math.abs(score - 1) < 1e-10),
  ).toBe(true);
});
it('missing people remain pending, critical mistakes block despite other perfect ratings', () => {
  const { review, measurements } = fixture();
  review.trials.forEach((t) => {
    t.provenance = 'REAL_PROVIDER';
    t.ratings = [];
  });
  expect(evaluateTranslation(review, measurements).status).toBe(
    'AWAITING_HUMAN_REVIEW',
  );
  review.trials[0]!.ratings = [
    {
      reviewer_id: 'human',
      blind_label: 'sample-17',
      reviewed_at: '2026-10-07T11:00:00Z',
      scores: [4, 4, 4, 4],
      critical_errors: ['NEGATION_CHANGED'],
    },
  ];
  expect(evaluateTranslation(review, measurements)).toMatchObject({
    status: 'FAIL',
    critical_errors: 1,
  });
  review.trials[0]!.ratings[0]!.scores = [null, null, null, null];
  expect(evaluateTranslation(review, measurements)).toMatchObject({
    status: 'FAIL',
    critical_errors: 1,
  });
});
it('preserves disagreements, missing outputs and unknown usage without zero assumptions', () => {
  const { review, measurements } = fixture();
  review.trials.forEach((t) => (t.provenance = 'REAL_PROVIDER'));
  review.trials[0]!.ratings[1]!.scores = [3, 4, 4, 4];
  measurements[0]!.input_tokens = null;
  measurements[0]!.complete = false;
  measurements[0]!.missing_segments = 2;
  const report = evaluateTranslation(review, measurements);
  expect(report).toMatchObject({
    status: 'FAIL',
    human_disagreements: 1,
    missing_segments: 2,
  });
  expect(report.variants.A.unknown_usage).toBe(1);
  expect(report.reasons).toContain('ACTUAL_USAGE_UNKNOWN');
  expect(report.reasons).toContain('HUMAN_DISAGREEMENT_REQUIRES_REVIEW');
});
it('requires paired repeats and rejects reuse of responses or blind identities', () => {
  const { review, measurements } = fixture();
  review.trials.pop();
  measurements.pop();
  expect(evaluateTranslation(review, measurements).reasons).toContain(
    'MISSING_PAIRED_TRIAL',
  );
  review.trials[1]!.request_id = review.trials[0]!.request_id;
  measurements[1]!.request_id = review.trials[0]!.request_id;
  expect(() => evaluateTranslation(review, measurements)).toThrow(
    'INVALID_TRANSLATION_TRIAL',
  );
});
