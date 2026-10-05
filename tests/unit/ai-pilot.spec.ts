import { it, expect } from 'vitest';
import {
  evaluateAiPilot,
  binomialMetric,
  type PilotReview,
} from '../../tools/gates/ai-pilot-evaluation.js';
function fixture(): PilotReview {
  const hash = 'a'.repeat(64);
  return {
    version: 'ai-pilot-review:1',
    scope: {
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      prompt_hash: hash,
      wire_hash: hash,
      canonical_schema_hash: hash,
      enrichment_version: '1.0',
      normalizer_version: 'source-normalizer:1',
      quality_scope: hash,
    },
    films: Array.from({ length: 12 }, (_, i) => ({
      video_id: 'fixture' + String(i).padStart(4, '0'),
      source_hash: hash,
      manifest_hash: hash,
      candidate_hash: hash,
      canonical_hash: hash,
      annotations_hash: hash,
      annotations_frozen_at: '2026-10-05T00:00:00Z',
      provider_started_at: '2026-10-06T00:00:00Z',
      cases:
        i === 0
          ? [
              'NEGATION',
              'CONDITION',
              'NUMBER',
              'REPORTED_SPEECH',
              'STANCE_USAGE',
              'PREDICTION_HORIZON',
              'ENTITY_AMBIGUITY',
              'ASR_DIFFICULT',
            ]
          : [],
      canonical_element_ids: ['a', 'b', 'c', 'd'],
      elements: ['a', 'b', 'c', 'd'].map((element_id) => ({
        element_id,
        supported: true,
        anchor_valid: true,
        severe_hallucination: false,
      })),
      important_claims: ['a', 'b', 'c', 'd'].map((claim_id) => ({
        claim_id,
        matched_element_ids: [claim_id],
      })),
      human: {
        reviewer_id: 'reviewer-a',
        independent_reviewer_id: 'reviewer-b',
        reviewed_at: '2026-10-06T01:00:00Z',
        disagreements_resolved: true,
        summary_coverage: true,
        stance_usage: true,
        prediction_qualifiers: true,
        entity_alias_ambiguity: true,
      },
      provider: {
        provenance: 'FIXTURE' as const,
        request_id: 'request-' + i,
        response_hash: hash,
        quota_snapshot_ids: ['rpm', 'rpd', 'tpm'],
        usage_logged: true,
        input_tokens: 100,
        output_tokens: 100,
        completion: 'OK',
        raw_json_valid: true,
        wire_valid: true,
        canonical_valid: true,
        source_complete: true,
        deterministic_repairs: [],
        ai_repairs: 0,
        latency_ms: 1000,
        cpu_ms: null,
      },
    })),
  };
}
it('perfect fixture labels never prove provider readiness or publish an approval', () => {
  const report = evaluateAiPilot(fixture());
  expect(report.precision).toMatchObject({ rate: 1, n: 48 });
  expect(report.recall).toMatchObject({ rate: 1, n: 48 });
  expect(report).toMatchObject({
    status: 'NOT_RUN',
    full_gate_ai: 'NOT_RUN',
    approval_published: false,
  });
  expect(report.reasons).toContain('REAL_PROVIDER_REQUIRED');
  expect(evaluateAiPilot(fixture(), 'FULL_GATE_AI').reasons).toContain(
    'INSUFFICIENT_CORPUS',
  );
});
it('keeps failed, unsupported and omitted claims in denominators and rejects missing labels', () => {
  const review = fixture();
  review.films[0]!.elements[0]!.supported = false;
  review.films[0]!.elements[1]!.severe_hallucination = true;
  review.films[1]!.elements[0]!.anchor_valid = false;
  review.films[2]!.important_claims[0]!.matched_element_ids = [];
  review.films[3]!.provider.input_tokens = null;
  const report = evaluateAiPilot(review);
  expect(report.precision).toMatchObject({ successes: 47, n: 48 });
  expect(report.recall).toMatchObject({ successes: 46, n: 48 });
  expect(report.anchor_validation).toMatchObject({ successes: 47, n: 48 });
  expect(report.reasons).toEqual(
    expect.arrayContaining([
      'SEVERE_HALLUCINATION',
      'ANCHOR_VALIDATION_BELOW_100_PERCENT',
    ]),
  );
  expect(report.usage).toMatchObject({
    known_input_tokens: 1100,
    films_with_unknown_usage: 1,
  });
  review.films[0]!.elements.pop();
  expect(() => evaluateAiPilot(review)).toThrow(
    'INCOMPLETE_PILOT_ELEMENT_LABELS',
  );
});
it('rejects post-output annotations, incomplete independent review, duplicate film/request and foreign matching IDs', () => {
  const review = fixture();
  review.films[0]!.annotations_frozen_at = '2026-10-07T00:00:00Z';
  review.films[1]!.cases = ['NEGATION'];
  review.films[1]!.human.independent_reviewer_id = null;
  review.films[2]!.elements[0]!.supported = null;
  expect(evaluateAiPilot(review).reasons).toEqual(
    expect.arrayContaining([
      'ANNOTATIONS_NOT_FROZEN_BEFORE_REQUEST',
      'INDEPENDENT_CRITICAL_REVIEW_REQUIRED',
      'UNKNOWN_HUMAN_LABEL',
    ]),
  );
  review.films[2]!.important_claims[0]!.matched_element_ids = ['foreign'];
  expect(() => evaluateAiPilot(review)).toThrow('INVALID_PILOT_CLAIM_MAPPING');
  const duplicate = fixture();
  duplicate.films[1]!.video_id = duplicate.films[0]!.video_id;
  expect(() => evaluateAiPilot(duplicate)).toThrow('INVALID_PILOT_IDENTITY');
});
it('reports nullable zero denominators and honest finite-sample Wilson intervals', () => {
  expect(binomialMetric(0, 0)).toEqual({
    successes: 0,
    n: 0,
    rate: null,
    ci95: null,
  });
  const perfect = binomialMetric(40, 40);
  expect(perfect.ci95![0]).toBeGreaterThan(0.91);
  expect(perfect.ci95![0]).toBeLessThan(0.92);
  expect(perfect.ci95![1]).toBeCloseTo(1);
});
