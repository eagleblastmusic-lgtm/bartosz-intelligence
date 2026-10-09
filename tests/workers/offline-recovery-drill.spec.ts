import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import { drillOffline } from '../../tools/gates/reliability/local-offline.js';
beforeEach(resetCore);
it('preserves deferred local work across unknown quota and executor restart without cloud fallback', async () => {
  const result = await drillOffline(env.DB, await fixtureOwner(), fixtureNow);
  expect(result.pass).toBe(true);
  expect(result.observations).toMatchObject({
    quota_reservations: 0,
    provider_requests: 0,
    offline_state: 'DEFERRED',
    accepted_effects: 1,
    old_fence_rejected: true,
    duplicate_idempotent: true,
    origin_preserved: true,
  });
});
