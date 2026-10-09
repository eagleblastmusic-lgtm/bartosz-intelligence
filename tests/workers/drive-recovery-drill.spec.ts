import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import { drillDrive } from '../../tools/gates/reliability/local-drive.js';
beforeEach(resetCore);
it('resumes the sealed Daily artifact after consumer failure and restart with one verified effect', async () => {
  const result = await drillDrive(env.DB, await fixtureOwner(), fixtureNow);
  expect(result.pass).toBe(true);
});
