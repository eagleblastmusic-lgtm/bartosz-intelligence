import { expect, it } from 'vitest';
import type { FunctionalFetchObservation } from '../../tools/gates/gate0-functional-evaluation.js';
import { evaluateGate0FunctionalCaptions } from '../../tools/gates/gate0-functional-evaluation.js';

function row(
  id: string,
  within: boolean | null,
  attempt = 1,
): FunctionalFetchObservation {
  return {
    video_id: id,
    operation: 'fetch_track',
    status: 'OK',
    attempt_number: attempt,
    result: { within_duration: within, is_translated_track: false },
  };
}
it('rejects successful fetches that violate frozen duration bounds', () => {
  const rows = Array.from({ length: 35 }, (_, i) => row(String(i), i >= 7));
  const before = JSON.stringify(rows);
  const result = evaluateGate0FunctionalCaptions(rows, 36, 0.95);
  expect(result.acquisition_successes).toBe(35);
  expect(result.functional_successes).toBe(28);
  expect(result.duration_conflicts).toHaveLength(7);
  expect(result.status).toBe('FAIL');
  expect(JSON.stringify(rows)).toBe(before);
});
it('preserves denominator and does not count duplicate attempts', () => {
  expect(
    evaluateGate0FunctionalCaptions(
      [row('a', true), row('a', true, 2)],
      2,
      0.95,
    ),
  ).toMatchObject({ functional_successes: 1, status: 'FAIL' });
});
it('missing duration evidence is inconclusive, never PASS', () => {
  expect(
    evaluateGate0FunctionalCaptions([row('a', null)], 1, 0.95).status,
  ).toBe('INCONCLUSIVE');
  expect(evaluateGate0FunctionalCaptions([], 0, 0.95).status).toBe(
    'INCONCLUSIVE',
  );
});
it('a newer failed attempt cannot leave stale success in the numerator', () => {
  const failed = { ...row('a', true, 2), status: 'TEMPORARY_FAILURE' as const };
  expect(
    evaluateGate0FunctionalCaptions([row('a', true), failed], 1, 0.95),
  ).toMatchObject({
    acquisition_successes: 0,
    functional_successes: 0,
    status: 'FAIL',
  });
});
it('passes a valid source result and excludes translated tracks', () => {
  expect(
    evaluateGate0FunctionalCaptions([row('a', true)], 1, 0.95).status,
  ).toBe('PASS');
  const translated = row('a', true);
  translated.result!.is_translated_track = true;
  expect(evaluateGate0FunctionalCaptions([translated], 1, 0.95).status).toBe(
    'FAIL',
  );
});
