import { env } from 'cloudflare:workers';
import { beforeEach, it, expect } from 'vitest';
import worker from '../../apps/api/src/index.js';
import { scheduleControlPlane } from '../../apps/api/src/scheduled.js';
import { fixtureNow, fixtureOwner, resetCore } from './core-fixture.js';
import { addSource } from '../../packages/core/src/sources/youtube/backfill.js';
import { randomToken, sha256 } from '../../packages/core/src/auth/crypto.js';
import type { QueueSignal } from '../../packages/contracts/src/jobs.js';
beforeEach(resetCore);

async function setup() {
  const access = await fixtureOwner();
  const intent = await addSource(
    env.DB,
    access,
    {
      namespace: 'youtube',
      external_id: 'UC' + 'q'.repeat(22),
      uploads_playlist_id: 'UU' + 'q'.repeat(22),
      canonical_locator: 'https://www.youtube.com/channel/UC' + 'q'.repeat(22),
      title: 'Fixture',
      handle: '@fixture',
    },
    'queue-control-test',
    {
      window_start: '2026-09-05T17:30:00.000Z',
      window_end: fixtureNow.toISOString(),
    },
    fixtureNow,
  );
  const candidates = Array.from({ length: 7 }, (_, index) => ({
    namespace: 'youtube',
    external_id: String(index).padStart(11, '0'),
    item_type: 'unknown',
    canonical_url: `https://www.youtube.com/watch?v=${String(index).padStart(11, '0')}`,
    title: 'Fixture',
    published_at: '2026-10-01T00:00:00.000Z',
    publication_provenance: 'videos.snippet.publishedAt',
    availability: 'PUBLIC',
    duration_seconds: 60,
  }));
  await env.DB.prepare(
    'UPDATE discovery_scans SET staged_page_json=?,staged_page_hash=?,staged_next_cursor=NULL WHERE job_id=?',
  )
    .bind(
      JSON.stringify(candidates),
      await sha256(JSON.stringify(candidates)),
      intent.job_id,
    )
    .run();
  await env.DB.prepare(
    'UPDATE sources SET rss_due_at=?,head_due_at=?,full_due_at=?,weekly_due_at=?,due_at=?',
  )
    .bind(...Array(5).fill('2099-01-01T00:00:00.000Z'))
    .run();
  const credential = randomToken();
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'control',
      'a',
      await sha256(credential),
      '["DISCOVER","RECONCILE"]',
      fixtureNow.toISOString(),
    )
    .run();
  return {
    intent,
    credential,
    signal: {
      job_id: intent.job_id,
      task_type: 'DISCOVER',
      fencing_hint: null,
    } as QueueSignal,
  };
}
function message(signal: QueueSignal) {
  const actions = { ack: 0, retry: 0 };
  const batch = {
    messages: [
      {
        body: signal,
        ack() {
          actions.ack++;
        },
        retry() {
          actions.retry++;
        },
      },
    ],
  } as unknown as MessageBatch<unknown>;
  return { actions, batch };
}
it('actual Queue entry commits bounded chunks, cron recovers a lost continuation, and duplicate hints preserve effects', async () => {
  const { intent, credential, signal } = await setup();
  let queries = 0,
    failSend = true;
  const hints: QueueSignal[] = [];
  const metered = {
    prepare(sql: string) {
      queries++;
      return env.DB.prepare(sql);
    },
    batch: env.DB.batch.bind(env.DB),
  } as typeof env.DB;
  const queue = {
    async send(hint: QueueSignal) {
      if (failSend) throw new Error('fixture transport failure');
      hints.push(hint);
    },
  } as unknown as Queue;
  const settings = {
    ...env,
    DB: metered,
    BARTOSZ_QUEUE: queue,
    CONTROL_WORKER_CREDENTIAL: credential,
    YOUTUBE_API_KEY: 'fixture-no-network',
  };
  const first = message(signal);
  await worker.queue(first.batch, settings);
  expect(first.actions).toEqual({ ack: 0, retry: 1 });
  expect(queries).toBeLessThanOrEqual(50);
  expect(
    await env.DB.prepare('SELECT state,reason_code FROM jobs WHERE job_id=?')
      .bind(intent.job_id)
      .first(),
  ).toMatchObject({ state: 'DEFERRED', reason_code: 'CONTINUATION' });
  failSend = false;
  queries = 0;
  await scheduleControlPlane(metered, queue, new Date());
  expect(queries).toBeLessThanOrEqual(50);
  expect(hints.some((hint) => hint.job_id === intent.job_id)).toBe(true);
  // Lost original transport and continuation cannot lose the canonical page offset.
  for (let index = 0; index < 3; index++) {
    queries = 0;
    const next = message(signal);
    await worker.queue(next.batch, settings);
    expect(next.actions).toEqual({ ack: 1, retry: 0 });
    expect(queries).toBeLessThanOrEqual(50);
  }
  expect(
    await env.DB.prepare('SELECT state,fencing_token FROM jobs WHERE job_id=?')
      .bind(intent.job_id)
      .first(),
  ).toMatchObject({ state: 'SUCCEEDED', fencing_token: 3 });
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM items').first('n')).toBe(
    7,
  );
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE task_type='FETCH_TRANSCRIPT'",
    ).first('n'),
  ).toBe(7);
  expect(
    await env.DB.prepare(
      'SELECT last_complete_window_end FROM sources WHERE source_id=?',
    )
      .bind(intent.source_id)
      .first('last_complete_window_end'),
  ).toBe(fixtureNow.toISOString());
});
it('a revoked configured credential cannot mutate discovery even with a Queue hint', async () => {
  const { intent, credential, signal } = await setup();
  await env.DB.prepare(
    'UPDATE worker_identities SET revoked_at=? WHERE worker_id=?',
  )
    .bind(new Date().toISOString(), 'control')
    .run();
  const incoming = message(signal);
  await worker.queue(incoming.batch, {
    ...env,
    CONTROL_WORKER_CREDENTIAL: credential,
    YOUTUBE_API_KEY: 'fixture-no-network',
  });
  expect(incoming.actions).toEqual({ ack: 0, retry: 1 });
  expect(
    await env.DB.prepare('SELECT state,fencing_token FROM jobs WHERE job_id=?')
      .bind(intent.job_id)
      .first(),
  ).toMatchObject({ state: 'PENDING', fencing_token: 0 });
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM items').first('n')).toBe(
    0,
  );
});
