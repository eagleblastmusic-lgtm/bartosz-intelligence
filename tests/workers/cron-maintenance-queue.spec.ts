import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import worker from '../../apps/api/src/index.js';
import { fixtureNow, fixtureOwner, resetCore } from './core-fixture.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { enrollMonitoringBatch } from '../../packages/core/src/sources/youtube/cycles.js';
import {
  commitDiscoveryPage,
  getScan,
} from '../../packages/core/src/sources/youtube/discovery.js';

beforeEach(resetCore);

function incoming(body: unknown) {
  const actions = { ack: 0, retries: [] as unknown[] };
  const batch = {
    messages: [
      {
        body,
        ack() {
          actions.ack++;
        },
        retry(options: unknown) {
          actions.retries.push(options);
        },
      },
    ],
  } as unknown as MessageBatch<unknown>;
  return { batch, actions };
}

function settings(hints: unknown[], credential?: string) {
  return {
    ...env,
    BARTOSZ_QUEUE: {
      async send(hint: unknown) {
        hints.push(hint);
      },
    } as unknown as Queue,
    CONTROL_WORKER_CREDENTIAL: credential,
    MONITORING_SLOTS: '15:00,23:00',
    AUTOMATIC_AI_ENABLED: 'false',
    RETENTION_DELETION_ENABLED: 'false',
  };
}

it.each([false, true])(
  'Cron sends its original occurrence durably with zero SQL and preserves optional hints (enabled=%s)',
  async (enabled) => {
    const hints: unknown[] = [],
      pending: Promise<unknown>[] = [];
    let queries = 0;
    const environment = {
      ...settings(hints),
      DB: {
        prepare() {
          queries++;
          throw new Error('Cron must not execute SQL');
        },
        batch() {
          queries++;
          throw new Error('Cron must not execute SQL');
        },
      } as unknown as D1Database,
      DRIVE_EXPORT_ENABLED: String(enabled),
      DAILY_REPORTS_ENABLED: String(enabled),
      TRANSCRIPT_ARCHIVE_ENABLED: String(enabled),
    };
    worker.scheduled(
      { scheduledTime: fixtureNow.getTime() } as ScheduledController,
      environment,
      {
        waitUntil(promise: Promise<unknown>) {
          pending.push(promise);
        },
      } as ExecutionContext,
    );
    await Promise.all(pending);
    expect(queries).toBe(0);
    expect(hints).toEqual([
      {
        kind: 'CONTROL_MAINTENANCE',
        scheduled_at: fixtureNow.toISOString(),
      },
      ...(enabled
        ? [
            { kind: 'DRIVE_EXPORT' },
            { kind: 'DAILY_WORKFLOW' },
            { kind: 'DAILY_TRANSCRIPTS' },
            { kind: 'TRANSCRIPT_ARCHIVE' },
          ]
        : []),
    ]);
  },
);

async function credential(scopes = ['DISCOVER', 'RECONCILE'], revoked = false) {
  const value = 'cron-maintenance-credential-fixture';
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,?)')
    .bind(
      'control-maintenance',
      'a',
      await sha256(value),
      JSON.stringify(scopes),
      fixtureNow.toISOString(),
      revoked ? fixtureNow.toISOString() : null,
    )
    .run();
  return value;
}

it('Queue executes bounded maintenance at the original Warsaw slot and deduplicates a delayed/replayed occurrence', async () => {
  const owner = await fixtureOwner();
  await new SourceRepository(env.DB, owner).upsert(
    {
      namespace: 'youtube',
      external_id: 'UC-maintenance',
      canonical_locator: 'https://www.youtube.com/channel/UC-maintenance',
      title: 'Maintenance fixture',
      uploads_playlist_id: 'UU-maintenance',
      handle: null,
    },
    fixtureNow.toISOString(),
  );
  const hints: unknown[] = [],
    environment = {
      ...settings(hints, await credential()),
      MONITORING_SLOTS: '23:00',
    },
    occurrence = '2026-10-05T21:00:00.000Z'; // Warsaw 23:00, delivered another day.
  for (let attempt = 0; attempt < 2; attempt++) {
    const message = incoming({
      kind: 'CONTROL_MAINTENANCE',
      scheduled_at: occurrence,
    });
    await worker.queue(message.batch, environment);
    expect(message.actions).toEqual({ ack: 1, retries: [] });
  }
  expect(
    await env.DB.prepare(
      'SELECT local_date,slot,total,started_at,state FROM monitoring_cycles',
    ).all(),
  ).toMatchObject({
    results: [
      {
        local_date: '2026-10-05',
        slot: '23:00',
        total: 1,
        started_at: occurrence,
        state: 'ENROLLING',
      },
    ],
  });
  expect(hints).toContainEqual({
    kind: 'SOURCE_CYCLE',
    cycle_id: 'monitor:a:2026-10-05:23:00',
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE task_type IN ('ANALYZE','PROJECT')",
    ).first('n'),
  ).toBe(0);
  expect(hints).not.toContainEqual({ kind: 'LEGACY_RETENTION' });
});

it('maintenance retains the persisted cycle and sixty-second backoff when a continuation send fails', async () => {
  const owner = await fixtureOwner();
  await new SourceRepository(env.DB, owner).upsert(
    {
      namespace: 'youtube',
      external_id: 'UC-maintenance-retry',
      canonical_locator: 'https://www.youtube.com/channel/UC-maintenance-retry',
      title: 'Maintenance retry fixture',
      uploads_playlist_id: 'UU-maintenance-retry',
      handle: null,
    },
    fixtureNow.toISOString(),
  );
  const hints: unknown[] = [],
    configured = {
      ...settings(hints, await credential()),
      MONITORING_SLOTS: '23:00',
    },
    body = {
      kind: 'CONTROL_MAINTENANCE',
      scheduled_at: '2026-10-05T21:00:00.000Z',
    },
    first = incoming(body);
  await worker.queue(first.batch, {
    ...configured,
    BARTOSZ_QUEUE: {
      async send() {
        throw new Error('Continuation transport failure');
      },
    } as unknown as Queue,
  });
  expect(first.actions).toEqual({
    ack: 0,
    retries: [{ delaySeconds: 60 }],
  });
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM monitoring_cycles').first('n'),
  ).toBe(1);
  const replay = incoming(body);
  await worker.queue(replay.batch, configured);
  expect(replay.actions).toEqual({ ack: 1, retries: [] });
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM monitoring_cycles').first('n'),
  ).toBe(1);
  expect(hints).toContainEqual({
    kind: 'SOURCE_CYCLE',
    cycle_id: 'monitor:a:2026-10-05:23:00',
  });
});

it('a delayed occurrence preserves its old slot while finishing a newer committed cycle at the actual execution time', async () => {
  const owner = await fixtureOwner(),
    source = (await new SourceRepository(env.DB, owner).upsert(
      {
        namespace: 'youtube',
        external_id: 'UC-maintenance-clock',
        canonical_locator:
          'https://www.youtube.com/channel/UC-maintenance-clock',
        title: 'Maintenance clock fixture',
        uploads_playlist_id: 'UU-maintenance-clock',
        handle: null,
      },
      fixtureNow.toISOString(),
    ))!,
    value = await credential(),
    context = await AccessContext.worker(env.DB, await sha256(value)),
    started = new Date('2026-10-06T10:00:00.000Z'),
    scanFinished = new Date('2026-10-06T10:01:00.000Z');
  await env.DB.prepare(
    "INSERT INTO monitoring_cycles(cycle_id,owner_id,local_date,slot,members_json,total,started_at,updated_at) VALUES('manual:newer','a','2026-10-06','MANUAL:newer',?,1,?,?)",
  )
    .bind(
      JSON.stringify([source.source_id]),
      started.toISOString(),
      started.toISOString(),
    )
    .run();
  await enrollMonitoringBatch(env.DB, started, 'manual:newer');
  const scanJob = (await env.DB.prepare(
      "SELECT job_id FROM discovery_scans WHERE monitoring_cycle_id='manual:newer'",
    ).first<{ job_id: string }>())!,
    store = new JobStore(env.DB, context),
    token = (await store.lease(
      scanJob.job_id,
      'DISCOVER',
      scanFinished,
      'local',
    ))!;
  await store.start(token, 'DISCOVER', scanFinished);
  await commitDiscoveryPage(
    env.DB,
    context,
    token,
    (await getScan(env.DB, context, scanJob.job_id))!,
    [],
    null,
    scanFinished,
  );
  expect(
    await env.DB.prepare(
      'SELECT j.state,a.finished_at FROM jobs j JOIN job_attempts a ON a.owner_id=j.owner_id AND a.job_id=j.job_id AND a.fencing_token=j.fencing_token WHERE j.job_id=?',
    )
      .bind(scanJob.job_id)
      .first(),
  ).toEqual({ state: 'SUCCEEDED', finished_at: scanFinished.toISOString() });
  expect(
    await env.DB.prepare(
      "SELECT state FROM monitoring_cycles WHERE cycle_id='manual:newer'",
    ).first('state'),
  ).toBe('RUNNING');

  const hints: unknown[] = [],
    message = incoming({
      kind: 'CONTROL_MAINTENANCE',
      scheduled_at: '2026-10-05T21:00:00.000Z',
    }),
    before = Date.now();
  await worker.queue(message.batch, {
    ...settings(hints, value),
    MONITORING_SLOTS: '23:00',
  });
  const after = Date.now();
  expect(message.actions).toEqual({ ack: 1, retries: [] });
  const finished = (await env.DB.prepare(
    "SELECT state,started_at,finished_at FROM monitoring_cycles WHERE cycle_id='manual:newer'",
  ).first<{ state: string; started_at: string; finished_at: string }>())!;
  expect(finished.state).toBe('COMPLETE');
  expect(finished.started_at).toBe(started.toISOString());
  expect(Date.parse(finished.finished_at)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(finished.finished_at)).toBeLessThanOrEqual(after);
  expect(Date.parse(finished.finished_at)).toBeGreaterThan(
    scanFinished.getTime(),
  );
  expect(
    await env.DB.prepare(
      "SELECT local_date,slot,started_at FROM monitoring_cycles WHERE cycle_id='monitor:a:2026-10-05:23:00'",
    ).first(),
  ).toEqual({
    local_date: '2026-10-05',
    slot: '23:00',
    started_at: '2026-10-05T21:00:00.000Z',
  });
});

it.each([
  { kind: 'CONTROL_MAINTENANCE' },
  { kind: 'CONTROL_MAINTENANCE', scheduled_at: 123 },
  { kind: 'CONTROL_MAINTENANCE', scheduled_at: 'invalid' },
  { kind: 'CONTROL_MAINTENANCE', scheduled_at: '2026-10-05T21:00:00+00:00' },
  { kind: 'CONTROL_MAINTENANCE', scheduled_at: '2999-01-01T00:00:00.000Z' },
  {
    kind: 'CONTROL_MAINTENANCE',
    scheduled_at: '2026-10-05T21:00:00.000Z',
    automatic_ai_enabled: true,
  },
])('malformed/future maintenance does not touch D1: %j', async (body) => {
  let queries = 0;
  const environment = {
    ...settings([], 'present-but-not-resolved'),
    DB: {
      prepare() {
        queries++;
        throw new Error('Invalid hint must not execute SQL');
      },
    } as unknown as D1Database,
  };
  const message = incoming(body);
  await worker.queue(message.batch, environment);
  expect(queries).toBe(0);
  expect(message.actions).toEqual({
    ack: 0,
    retries: [{ delaySeconds: 60 }],
  });
});

it.each([
  ['missing', [], false],
  ['invalid', [], false],
  ['revoked', ['DISCOVER', 'RECONCILE'], true],
  ['only DISCOVER', ['DISCOVER'], false],
  ['only RECONCILE', ['RECONCILE'], false],
] as const)(
  'maintenance cannot run with a %s credential',
  async (mode, scopes, revoked) => {
    const value =
      mode === 'missing'
        ? undefined
        : mode === 'invalid'
          ? 'unregistered-fixture'
          : await credential([...scopes], revoked);
    const hints: unknown[] = [],
      message = incoming({
        kind: 'CONTROL_MAINTENANCE',
        scheduled_at: fixtureNow.toISOString(),
      });
    await worker.queue(message.batch, settings(hints, value));
    expect(message.actions).toEqual({
      ack: 0,
      retries: [{ delaySeconds: 60 }],
    });
    expect(hints).toHaveLength(0);
    expect(
      await env.DB.prepare('SELECT COUNT(*) n FROM monitoring_cycles').first(
        'n',
      ),
    ).toBe(0);
  },
);

it('a failed durable maintenance send is observable instead of falling back to Cron SQL', async () => {
  const pending: Promise<unknown>[] = [];
  worker.scheduled(
    { scheduledTime: fixtureNow.getTime() } as ScheduledController,
    {
      ...settings([]),
      BARTOSZ_QUEUE: {
        async send() {
          throw new Error('Queue unavailable');
        },
      } as unknown as Queue,
    },
    {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    } as ExecutionContext,
  );
  expect(await Promise.allSettled(pending)).toEqual([
    { status: 'rejected', reason: new Error('Queue unavailable') },
    { status: 'fulfilled', value: undefined },
  ]);
});
