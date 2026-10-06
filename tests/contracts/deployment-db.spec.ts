import { it, expect } from 'vitest';
import { remoteDatabase } from '../../tools/deployment/cloudflare.mjs';
it('administrative Core bridge keeps bound values separate and batches in one REST operation', async () => {
  const calls: unknown[] = [];
  const db = remoteDatabase(async (batch) => {
    calls.push(batch);
    return batch.map(() => ({
      success: true,
      results: [{ n: 3 }],
      meta: { changes: 1 },
    }));
  });
  const statement = db.prepare('SELECT n WHERE key=?').bind("';untrusted");
  expect(await statement.first('n')).toBe(3);
  expect(await statement.all()).toEqual({ results: [{ n: 3 }] });
  await db.batch([statement, db.prepare('UPDATE config SET n=?').bind(4)]);
  expect(calls.at(-1)).toEqual([
    { sql: 'SELECT n WHERE key=?', params: ["';untrusted"] },
    { sql: 'UPDATE config SET n=?', params: [4] },
  ]);
  expect(calls).toHaveLength(3);
});
