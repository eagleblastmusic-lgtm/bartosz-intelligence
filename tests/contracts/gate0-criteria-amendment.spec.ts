import { expect, it } from 'vitest';
import {
  evaluateGate0FunctionalCaptions,
  evaluateGate0SourceFaithfulCaptions,
} from '../../tools/gates/gate0-functional-evaluation.js';
const row = {
  video_id: 'a',
  request_id: 'request-a',
  operation: 'fetch_track' as const,
  status: 'OK' as const,
  attempt_number: 1,
  result: { within_duration: false, is_translated_track: false },
};
const proof = {
  video_id: 'a',
  candidate_request_id: 'request-a',
  status: 'PASS',
  original_payload_hash_match: true,
  original_cue_count_match: true,
  all_cue_max_delta_ms: 0,
  all_cue_text_hashes_equal: true,
};
it('retains v1 FAIL and admits a source-exact overrun separately in v2', () => {
  const before = JSON.stringify(row);
  expect(evaluateGate0FunctionalCaptions([row], 1, 0.95).status).toBe('FAIL');
  expect(
    evaluateGate0SourceFaithfulCaptions([row], [proof], 1, 0.95, 250),
  ).toMatchObject({
    status: 'PASS',
    functional_successes: 1,
    source_duration_overruns: ['a'],
  });
  expect(JSON.stringify(row)).toBe(before);
});
it.each([
  { all_cue_max_delta_ms: 251 },
  { all_cue_max_delta_ms: NaN },
  { original_payload_hash_match: false },
  { original_cue_count_match: false },
  { all_cue_text_hashes_equal: false },
  { candidate_request_id: 'different' },
  { status: 'FAIL' },
])('never waives source integrity for a metadata overrun: %j', (delta) => {
  expect(
    evaluateGate0SourceFaithfulCaptions(
      [row],
      [{ ...proof, ...delta }],
      1,
      0.95,
      250,
    ).status,
  ).toBe('INCONCLUSIVE');
});
it('missing source evidence and later failed attempts cannot pass', () => {
  expect(
    evaluateGate0SourceFaithfulCaptions([row], [], 1, 0.95, 250).status,
  ).toBe('INCONCLUSIVE');
  expect(
    evaluateGate0SourceFaithfulCaptions(
      [row, { ...row, attempt_number: 2, status: 'TEMPORARY_FAILURE' }],
      [proof],
      1,
      0.95,
      250,
    ).status,
  ).toBe('FAIL');
});
