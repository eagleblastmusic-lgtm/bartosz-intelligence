import { expect, it } from 'vitest';
import { d1TestBudget } from '../../tools/deployment/d1-test-budget.js';
it('retains the committed result that crosses a measured budget and refuses the next request', async () => {
  let calls = 0;
  const bounded = d1TestBudget(
    async () => {
      calls++;
      return [{ meta: { rows_read: 11, rows_written: 1 }, committed: true }];
    },
    { requests: 3, rows_read: 10, rows_written: 2 },
  );
  expect(await bounded.execute(['diagnostic'])).toMatchObject([
    { committed: true },
  ]);
  expect(bounded.usage.stopped).toBe(true);
  await expect(bounded.execute(['next'])).rejects.toThrow(
    'D1_TEST_BUDGET_EXHAUSTED',
  );
  expect(calls).toBe(1);
  const empty = d1TestBudget(async () => [], {
    requests: 2,
    rows_read: 10,
    rows_written: 10,
  });
  expect(await empty.execute(['missing result'])).toEqual([]);
  expect(empty.usage.metadata_complete).toBe(false);
  await expect(empty.execute(['next'])).rejects.toThrow(
    'D1_TEST_BUDGET_EXHAUSTED',
  );
});
it('stops after ambiguous errors and missing metadata without automatic replay', async () => {
  const missing = d1TestBudget(async () => [{ meta: {} }], {
    requests: 2,
    rows_read: 10,
    rows_written: 10,
  });
  await missing.execute(['first']);
  expect(missing.usage.metadata_complete).toBe(false);
  await expect(missing.execute(['next'])).rejects.toThrow(
    'D1_TEST_BUDGET_EXHAUSTED',
  );
  let calls = 0;
  const ambiguous = d1TestBudget(
    async () => {
      calls++;
      throw new Error('CLOUDFLARE_TRANSPORT_FAILED');
    },
    { requests: 2, rows_read: 10, rows_written: 10 },
  );
  await expect(ambiguous.execute(['first'])).rejects.toThrow(
    'CLOUDFLARE_TRANSPORT_FAILED',
  );
  await expect(ambiguous.execute(['next'])).rejects.toThrow(
    'D1_TEST_BUDGET_EXHAUSTED',
  );
  expect(calls).toBe(1);
});
