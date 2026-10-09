import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import { drillTranscript } from '../../tools/gates/reliability/local-transcript.js';
beforeEach(resetCore);
it('retains failed transcript work across parser cooldown and restart without accepting stale or absent source', async () => {
  const result = await drillTranscript(
    env.DB,
    await fixtureOwner(),
    fixtureNow,
  );
  expect(result.pass).toBe(true);
  expect(result.observations.accepted_effects).toBe(0);
});
