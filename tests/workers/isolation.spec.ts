import { env } from 'cloudflare:workers';
import { it, expect } from 'vitest';
it('D1 is isolated across test files', async () => {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='smoke'",
  ).all();
  expect(tables.results).toEqual([]);
});
