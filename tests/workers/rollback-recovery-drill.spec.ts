import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import { drillRollback } from '../../tools/gates/reliability/local-rollback.js';
beforeEach(resetCore);
it('rolls back the prompt pointer without rewriting queued work or approving a replacement model', async () => {
  const result = await drillRollback(env.DB, await fixtureOwner(), fixtureNow);
  expect(result.pass).toBe(true);
});
