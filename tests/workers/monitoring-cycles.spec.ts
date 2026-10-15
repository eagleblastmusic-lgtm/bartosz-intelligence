import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { fixtureNow, fixtureOwner, resetCore } from './core-fixture.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import {
  startMonitoringCycles,
  enrollMonitoringBatch,
  refreshMonitoringProgress,
  wakeMonitoring,
} from '../../packages/core/src/sources/youtube/cycles.js';
import worker from '../../apps/api/src/index.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
beforeEach(resetCore);
it.each([
  ['SCHEDULED', 30],
  ['MANUAL', 20],
] as const)(
  '%s cycle finishes %i channels through immediate Queue invocations, including replay and lost hints',
  async (mode, count) => {
    const now =
      mode === 'MANUAL' ? new Date('2026-10-05T23:50:00.000Z') : fixtureNow;
    const owner = await fixtureOwner(),
      sources = new SourceRepository(env.DB, owner);
    for (let i = 0; i < count; i++)
      await sources.upsert(
        {
          namespace: 'youtube',
          external_id: `UC-${i}`,
          canonical_locator: `https://www.youtube.com/channel/UC-${i}`,
          title: 'Fixture',
          uploads_playlist_id: `UU-${i}`,
          handle: null,
        },
        fixtureNow.toISOString(),
      );
    if (mode === 'MANUAL') {
      // One administrative intent reuses the same bounded enrollment/Queue path.
      // It is visibly manual, outside the Warsaw slots, and does not change time.
      expect((await startMonitoringCycles(env.DB, now)).scheduled).toBe(0);
      const members = (
        await env.DB.prepare(
          "SELECT source_id FROM sources WHERE owner_id='a' AND enabled=1 ORDER BY source_id",
        ).all<{ source_id: string }>()
      ).results.map((row) => row.source_id);
      const insert = () =>
        env.DB.prepare(
          "INSERT INTO monitoring_cycles(cycle_id,owner_id,local_date,slot,members_json,total,started_at,updated_at) VALUES('manual:fixture','a','2026-10-06','MANUAL:fixture',?,?,?,?) ON CONFLICT(owner_id,local_date,slot) DO NOTHING",
        )
          .bind(
            JSON.stringify(members),
            members.length,
            now.toISOString(),
            now.toISOString(),
          )
          .run();
      expect((await insert()).meta.changes).toBe(1);
      expect((await insert()).meta.changes).toBe(0);
    } else {
      expect((await startMonitoringCycles(env.DB, now)).scheduled).toBe(1);
      expect((await startMonitoringCycles(env.DB, now)).scheduled).toBe(0);
    }
    await enrollMonitoringBatch(env.DB, now); // simulate crash after the first persisted batch
    expect(
      await env.DB.prepare('SELECT cursor FROM monitoring_cycles').first(
        'cursor',
      ),
    ).toBe(5);
    const hints: unknown[] = [];
    const queue = {
      send: async (h: unknown) => {
        hints.push(h);
      },
    } as unknown as Queue;
    await wakeMonitoring(env.DB, queue, now); // maintenance rebuilds a lost hint
    const credential = 'a'.repeat(43);
    await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
      .bind(
        'control',
        'a',
        await sha256(credential),
        '["DISCOVER","RECONCILE"]',
        fixtureNow.toISOString(),
      )
      .run();
    const settings = {
      ...env,
      BARTOSZ_QUEUE: queue,
      CONTROL_WORKER_CREDENTIAL: credential,
      YOUTUBE_API_KEY: 'fixture-no-network',
    };
    while ((hints[0] as { kind?: string })?.kind === 'SOURCE_CYCLE') {
      const hint = hints.shift();
      await worker.queue(
        {
          messages: [
            {
              body: hint,
              ack() {},
              retry() {
                throw new Error('unexpected retry');
              },
            },
          ],
        } as unknown as MessageBatch<unknown>,
        settings,
      );
    }
    expect(
      await env.DB.prepare('SELECT COUNT(*) n FROM discovery_scans').first('n'),
    ).toBe(count);
    if (mode === 'MANUAL') {
      expect(
        await env.DB.prepare(
          'SELECT slot,started_at FROM monitoring_cycles',
        ).first(),
      ).toEqual({ slot: 'MANUAL:fixture', started_at: now.toISOString() });
    }
    await refreshMonitoringProgress(env.DB, now);
    expect(
      await env.DB.prepare('SELECT state FROM monitoring_cycles').first(
        'state',
      ),
    ).toBe('RUNNING');
    // The existing executor processes synthetic staged pages, no live YouTube calls.
    await env.DB.prepare(
      'UPDATE discovery_scans SET staged_page_json=?,staged_page_hash=?',
    )
      .bind('[]', await sha256('[]'))
      .run();
    let invocations = 0;
    while (hints.length) {
      const hint = hints.shift();
      await worker.queue(
        {
          messages: [
            {
              body: hint,
              ack() {},
              retry() {
                throw new Error('unexpected retry');
              },
            },
          ],
        } as unknown as MessageBatch<unknown>,
        settings,
      );
      if (++invocations > count + 1) throw new Error('busy loop');
    }
    expect(invocations).toBe(count);
    expect(
      await env.DB.prepare(
        'SELECT state,total,completed,failed FROM monitoring_cycles',
      ).first(),
    ).toMatchObject({
      state: 'COMPLETE',
      total: count,
      completed: count,
      failed: 0,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM jobs WHERE state='SUCCEEDED'",
      ).first('n'),
    ).toBe(count);
    const hint = (await env.DB.prepare(
      'SELECT job_id FROM jobs LIMIT 1',
    ).first<{
      job_id: string;
    }>())!;
    await worker.queue(
      {
        messages: [
          {
            body: { ...hint, task_type: 'DISCOVER', fencing_hint: 0 },
            ack() {},
            retry() {
              throw new Error('unexpected retry');
            },
          },
        ],
      } as unknown as MessageBatch<unknown>,
      settings,
    );
    expect(hints).toHaveLength(0);
    expect(
      await env.DB.prepare('SELECT COUNT(*) n FROM job_attempts').first('n'),
    ).toBe(count);
  },
);
