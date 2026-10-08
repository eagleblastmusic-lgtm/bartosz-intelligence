import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import { drillDiscovery } from '../../tools/gates/reliability/local-discovery.js';
import { drillAuth } from '../../tools/gates/reliability/local-auth.js';
beforeEach(resetCore);
it('actual discovery drill recovers a staged page after SQL failure and expired lease', async () => {
  const result = await drillDiscovery(env.DB, await fixtureOwner(), fixtureNow);
  expect(result.pass).toBe(true);
  expect(result.observations).toEqual({
    batch_rejected: true,
    stale_rejected: true,
    items_before_recovery: 1,
    items_after_recovery: 2,
    transcript_jobs: 2,
    watermark_advanced_after_recovery: true,
  });
});
it('actual revocation drill fences an already running executor and recovers with fresh authorization', async () => {
  const owner = await fixtureOwner();
  const session = (await env.DB.prepare(
    'SELECT session_hash FROM owner_sessions WHERE owner_id=?',
  )
    .bind(owner.ownerId)
    .first<string>('session_hash'))!;
  const result = await drillAuth(env.DB, owner, session, fixtureNow);
  expect(result.pass).toBe(true);
  expect(result.observations).toEqual({
    worker_auth_rejected: true,
    old_completion_rejected: true,
    owner_session_rejected: true,
    replacement_accepted: true,
    accepted_effects: 1,
    origin_preserved: true,
  });
});
