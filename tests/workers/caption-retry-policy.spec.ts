import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { fixtureOwner, fixtureNow, resetCore } from './core-fixture.js';
import { enqueueYoutubeTranscript } from '../../packages/core/src/transcript/intake.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { TranscriptRecovery } from '../../packages/core/src/transcript/recovery.js';
import { sweep } from '../../packages/core/src/jobs/recovery.js';
beforeEach(resetCore);
it('three actual absences, technical failures and explicit replay preserve durable attempts', async () => {
  const owner = await fixtureOwner(),
    intent = await enqueueYoutubeTranscript(
      env.DB,
      owner,
      'abcdefghijk',
      fixtureNow,
    );
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'oracle',
      'a',
      await sha256('fixture'),
      '["FETCH_TRANSCRIPT"]',
      fixtureNow.toISOString(),
    )
    .run();
  const access = await AccessContext.worker(env.DB, await sha256('fixture')),
    store = new JobStore(env.DB, access),
    recovery = new TranscriptRecovery(env.DB, access);
  async function attempt(
    status: 'NO_CAPTIONS' | 'TEMPORARY_FAILURE',
    offset: number,
  ) {
    const now = new Date(fixtureNow.getTime() + offset);
    await sweep(env.DB, now, () => true);
    const lease = (await store.lease(
      intent.job_id,
      'FETCH_TRANSCRIPT',
      now,
      'local',
    ))!;
    expect(lease).not.toBeNull();
    await store.start(lease, 'FETCH_TRANSCRIPT', now);
    return recovery.outcome(lease, status, now, false, () => 0.5);
  }
  expect((await attempt('NO_CAPTIONS', 600000)).due_at).toBe(
    new Date(fixtureNow.getTime() + 3600000).toISOString(),
  );
  const technical = await attempt('TEMPORARY_FAILURE', 3600000);
  expect(technical.state).toBe('RETRY_WAIT');
  const second = await attempt(
    'NO_CAPTIONS',
    Math.max(Date.parse(technical.due_at) - fixtureNow.getTime(), 3601000),
  );
  expect(second.due_at).toBe(
    new Date(fixtureNow.getTime() + 36000000).toISOString(),
  );
  expect((await attempt('NO_CAPTIONS', 36000000)).reason).toBe(
    'LOCAL_YTDLP_NO_CAPTIONS_FINAL',
  );
  await sweep(env.DB, new Date(fixtureNow.getTime() + 86400000), () => true);
  expect((await store.get(intent.job_id))!.state).toBe('FAILED');
  await new JobStore(env.DB, owner).replay(
    intent.job_id,
    new Date(fixtureNow.getTime() + 86400000).toISOString(),
    'recheck',
  );
  expect((await attempt('NO_CAPTIONS', 86400000)).due_at).toBe(
    new Date(fixtureNow.getTime() + 90000000).toISOString(),
  );
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM job_attempts').first('n'),
  ).toBe(5);
});
