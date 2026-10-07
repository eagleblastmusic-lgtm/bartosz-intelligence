import { env } from 'cloudflare:workers';
import { beforeEach, it, expect } from 'vitest';
import {
  resetCore,
  resetSchema,
  fixtureOwner,
  fixtureNow,
} from './core-fixture.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import type { Database } from '../../packages/core/src/db/boundary.js';
import {
  addSource,
  backfillWindow,
} from '../../packages/core/src/sources/youtube/backfill.js';
import {
  getScan,
  commitDiscoveryPage,
} from '../../packages/core/src/sources/youtube/discovery.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { RunRepository } from '../../packages/core/src/jobs/acceptance.js';
import { sweep } from '../../packages/core/src/jobs/recovery.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import {
  CoreBackup,
  backupTables,
} from '../../packages/core/src/backup/snapshot.js';
import type { BackupChunk } from '../../packages/core/src/backup/snapshot.js';
import { restoreCanonical } from '../../packages/core/src/backup/restore.js';
import type { ItemMetadata } from '../../packages/contracts/src/discovery.js';
beforeEach(resetCore);
it('combined D1 recovery: duplicate discovery, DB rollback, expired transport/lease, stale fence, accepted effect and canonical restore', async () => {
  const owner = await fixtureOwner(),
    window = backfillWindow(fixtureNow);
  const intent = await addSource(
    env.DB,
    owner,
    {
      namespace: 'youtube',
      external_id: 'UC' + 'r'.repeat(22),
      uploads_playlist_id: 'UU' + 'r'.repeat(22),
      canonical_locator: 'https://www.youtube.com/channel/UC' + 'r'.repeat(22),
      title: 'Recovery fixture',
      handle: null,
    },
    'recovery-acceptance',
    window,
    fixtureNow,
  );
  const credential = await sha256('private-fixture-credential');
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'executor',
      'a',
      credential,
      '["DISCOVER","ANALYZE"]',
      fixtureNow.toISOString(),
    )
    .run();
  const access = await AccessContext.worker(env.DB, credential),
    store = new JobStore(env.DB, access);
  const item = (id: string): ItemMetadata => ({
    namespace: 'youtube',
    external_id: id,
    canonical_url: 'https://www.youtube.com/watch?v=' + id,
    title: 'Fixture',
    item_type: 'video',
    published_at: '2026-10-01T00:00:00.000Z',
    publication_provenance: 'fixture',
    availability: 'PUBLIC',
    duration_seconds: 60,
  });
  const first = (await store.lease(
    intent.job_id,
    'DISCOVER',
    fixtureNow,
    'cloud',
  ))!;
  await store.start(first, 'DISCOVER', fixtureNow);
  await commitDiscoveryPage(
    env.DB,
    access,
    first,
    (await getScan(env.DB, access, intent.job_id))!,
    [item('recovery001'), item('recovery001')],
    'page-2',
    fixtureNow,
  );
  await sweep(env.DB, fixtureNow, () => true);
  const interrupted = (await store.lease(
    intent.job_id,
    'DISCOVER',
    fixtureNow,
    'cloud',
  ))!;
  await store.start(interrupted, 'DISCOVER', fixtureNow);
  const failing: Database = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: (statements) =>
      env.DB.batch([
        ...statements,
        env.DB.prepare('INSERT INTO absent_fixture_table VALUES(1)'),
      ] as D1PreparedStatement[]),
  };
  await expect(
    commitDiscoveryPage(
      failing,
      access,
      interrupted,
      (await getScan(env.DB, access, intent.job_id))!,
      [item('recovery002')],
      null,
      fixtureNow,
    ),
  ).rejects.toThrow();
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM items').first('n')).toBe(
    1,
  );
  expect(
    await env.DB.prepare('SELECT last_complete_window_end FROM sources').first(
      'last_complete_window_end',
    ),
  ).toBeNull();
  // No transport is available during the crash. Durable D1 is the recovery authority.
  await env.DB.prepare('UPDATE outbox SET delivered_at=?')
    .bind(fixtureNow.toISOString())
    .run();
  const recoveredAt = new Date(fixtureNow.getTime() + 6 * 60000);
  await sweep(env.DB, recoveredAt, () => true);
  const resumed = (await store.lease(
    intent.job_id,
    'DISCOVER',
    recoveredAt,
    'cloud',
  ))!;
  await store.start(resumed, 'DISCOVER', recoveredAt);
  const scan = (await getScan(env.DB, access, intent.job_id))!;
  await expect(
    commitDiscoveryPage(
      env.DB,
      access,
      interrupted,
      scan,
      [],
      null,
      recoveredAt,
    ),
  ).rejects.toThrow('STALE_FENCE');
  await commitDiscoveryPage(
    env.DB,
    access,
    resumed,
    scan,
    [],
    null,
    recoveredAt,
  );
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM items').first('n')).toBe(
    2,
  );
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE task_type='FETCH_TRANSCRIPT'",
    ).first('n'),
  ).toBe(2);
  expect(
    await env.DB.prepare('SELECT last_complete_window_end FROM sources').first(
      'last_complete_window_end',
    ),
  ).toBe(window.window_end);
  const original = (await env.DB.prepare(
    "SELECT * FROM jobs WHERE task_type='FETCH_TRANSCRIPT' ORDER BY job_id LIMIT 1",
  ).first())!;
  const proofJob = (await new JobStore(env.DB, owner).enqueue(
    {
      item_id: String(original.item_id),
      source_id: intent.source_id,
      task_type: 'ANALYZE',
      input_revision: 'core-test-only',
      profile_revision: 'fixture',
      prompt_snapshot_id: null,
      routing_policy_version: 'fixture',
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: String(original.arrival_origin_at),
      origin_kind: 'BACKFILL',
      payload: {},
      priority: 20,
      due_at: recoveredAt.toISOString(),
    },
    recoveredAt.toISOString(),
  ))!;
  const token = (await store.lease(
    proofJob.job_id,
    'ANALYZE',
    recoveredAt,
    'local',
  ))!;
  await store.start(token, 'ANALYZE', recoveredAt);
  const runs = new RunRepository(env.DB, access);
  await runs.prepare(
    'deterministic-core-effect',
    proofJob.job_id,
    recoveredAt.toISOString(),
  );
  const revision = await new RunRepository(env.DB, owner).requestSelection(
    'deterministic-core-effect',
    String(original.item_id),
  );
  await runs.complete(
    token,
    'ANALYZE',
    'deterministic-core-effect',
    await sha256('{}'),
    {},
    revision,
    recoveredAt,
  );
  await expect(
    runs.complete(
      token,
      'ANALYZE',
      'deterministic-core-effect',
      await sha256('{}'),
      {},
      revision,
      recoveredAt,
    ),
  ).resolves.toMatchObject({ accepted: true, duplicate: true });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM analysis_runs WHERE state='ACCEPTED'",
    ).first('n'),
  ).toBe(1);
  const before = (
    await env.DB.prepare(
      'SELECT item_id,current_revision_id FROM items ORDER BY item_id',
    ).all()
  ).results;
  const backup = new CoreBackup(env.DB, owner),
    begun = await backup.begin(),
    chunks: BackupChunk[] = [];
  for (const table of backupTables) {
    let cursor: number | null = 0;
    do {
      const chunk = await backup.chunk(begun.backup_id, table, cursor);
      chunks.push(chunk);
      cursor = chunk.next_cursor;
    } while (cursor !== null);
  }
  const portable = { manifest: await backup.complete(begun.backup_id), chunks };
  // Replace only the disposable test database, using the real migration/restore path.
  await resetSchema();
  await restoreCanonical(env.DB, portable, 'subject-a');
  expect(
    (
      await env.DB.prepare(
        'SELECT item_id,current_revision_id FROM items ORDER BY item_id',
      ).all()
    ).results,
  ).toEqual(before);
  expect(
    await env.DB.prepare('SELECT last_complete_window_end FROM sources').first(
      'last_complete_window_end',
    ),
  ).toBe(window.window_end);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE task_type='FETCH_TRANSCRIPT'",
    ).first('n'),
  ).toBe(2);
  expect(
    await env.DB.prepare(
      'SELECT accepted_run_id FROM active_analysis_selections',
    ).first('accepted_run_id'),
  ).toBe('deterministic-core-effect');
  expect(
    await env.DB.prepare('SELECT arrival_origin_at FROM jobs WHERE job_id=?')
      .bind(proofJob.job_id)
      .first('arrival_origin_at'),
  ).toBe(original.arrival_origin_at);
  await expect(AccessContext.worker(env.DB, credential)).rejects.toThrow(
    'UNAUTHENTICATED',
  );
  expect(
    (await env.DB.prepare('PRAGMA foreign_key_check').all()).results,
  ).toEqual([]);
});
