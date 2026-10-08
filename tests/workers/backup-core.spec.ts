import { env } from 'cloudflare:workers';
import { beforeEach, it, expect } from 'vitest';
import {
  resetCore,
  resetSchema,
  fixtureOwner,
  fixtureNow,
} from './core-fixture.js';
import {
  CoreBackup,
  backupTables,
} from '../../packages/core/src/backup/snapshot.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { restoreCanonical } from '../../packages/core/src/backup/restore.js';
import type { BackupChunk } from '../../packages/core/src/backup/snapshot.js';
import type { Database } from '../../packages/core/src/db/boundary.js';
beforeEach(resetCore);
it('pins an explicit extended format and its bounded barrier, rejecting format mutation', async () => {
  const backup = new CoreBackup(env.DB, await fixtureOwner());
  await expect(backup.begin(3 as 2)).rejects.toThrow('INVALID_BACKUP_FORMAT');
  const before = Date.now(),
    started = await backup.begin(2);
  expect(started.format_version).toBe(2);
  expect(Date.parse(started.expires_at) - before).toBeGreaterThanOrEqual(
    600000,
  );
  expect(Date.parse(started.expires_at) - before).toBeLessThan(610000);
  await expect(
    env.DB.prepare(
      'UPDATE backup_snapshots SET format_version=1 WHERE backup_id=?',
    )
      .bind(started.backup_id)
      .run(),
  ).rejects.toThrow('IMMUTABLE_BACKUP_FORMAT');
  await backup.abort(started.backup_id);
});
it('starts a complete owner-scoped inventory within a bounded control-plane query budget', async () => {
  const owner = await fixtureOwner();
  let invocations = 0;
  const bounded: Database = {
    prepare(sql) {
      invocations++;
      if (invocations > 10) throw new Error('QUERY_BUDGET_EXCEEDED');
      return env.DB.prepare(sql);
    },
    batch: env.DB.batch.bind(env.DB),
  };
  const backup = new CoreBackup(bounded, owner);
  const started = await backup.begin();
  const row = await env.DB.prepare(
    'SELECT counts_json FROM backup_snapshots WHERE backup_id=?',
  )
    .bind(started.backup_id)
    .first<{ counts_json: string }>();
  const counts = JSON.parse(row!.counts_json) as Record<string, number>;
  expect(Object.keys(counts).sort()).toEqual([...backupTables].sort());
  expect(counts.owner_users).toBe(1);
  expect(invocations).toBeLessThanOrEqual(10);
  await new CoreBackup(env.DB, owner).abort(started.backup_id);
});
it('D1 mutation barrier freezes a consistent cut, rejects concurrent writer, hashes every chunk, and releases after verification', async () => {
  const owner = await fixtureOwner(),
    other = await fixtureOwner('b');
  await new SourceRepository(env.DB, owner).upsert(
    {
      namespace: 'youtube',
      external_id: 'UC-fixture',
      canonical_locator: 'https://www.youtube.com/channel/fixture',
      title: 'Fixture',
      uploads_playlist_id: 'UU-fixture',
      handle: null,
    },
    fixtureNow.toISOString(),
  );
  await new JobStore(env.DB, owner).enqueue(
    {
      item_id: null,
      source_id: null,
      task_type: 'FETCH_TRANSCRIPT',
      input_revision: 'fixture',
      profile_revision: 'economy-1',
      prompt_snapshot_id: null,
      routing_policy_version: 'local-primary-1',
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: fixtureNow.toISOString(),
      origin_kind: 'BACKFILL',
      payload: {},
      priority: 20,
      due_at: fixtureNow.toISOString(),
    },
    fixtureNow.toISOString(),
  );
  const backup = new CoreBackup(env.DB, owner),
    started = await backup.begin();
  await expect(
    new CoreBackup(env.DB, other).chunk(started.backup_id, 'sources', 0),
  ).rejects.toThrow('NOT_FOUND');
  await expect(backup.begin()).rejects.toThrow('BACKUP_BUSY');
  await expect(
    env.DB.prepare("UPDATE sources SET enabled=0 WHERE owner_id='a'").run(),
  ).rejects.toThrow('BACKUP_MUTATION_PAUSED');
  await expect(backup.complete(started.backup_id)).rejects.toThrow(
    'BACKUP_INCOMPLETE',
  );
  const portableChunks: BackupChunk[] = [];
  for (const table of backupTables) {
    let cursor: number | null = 0;
    do {
      const chunk = await backup.chunk(started.backup_id, table, cursor);
      portableChunks.push(chunk);
      expect(await sha256(JSON.stringify(chunk.rows))).toBe(chunk.sha256);
      expect(JSON.stringify(chunk)).not.toContain('subject-a');
      expect(chunk.columns).not.toContain('credential_hash');
      cursor = chunk.next_cursor;
    } while (cursor !== null);
  }
  const manifest = await backup.complete(started.backup_id);
  expect(manifest.tables.sources?.count).toBe(1);
  expect(manifest.tables.jobs?.count).toBe(1);
  expect(await backup.manifest(started.backup_id)).toEqual(manifest);
  expect(
    await env.DB.prepare('SELECT barrier_token FROM maintenance_state').first(
      'barrier_token',
    ),
  ).toBeNull();
  await env.DB.prepare("UPDATE sources SET enabled=0 WHERE owner_id='a'").run();
  // Reinitialize only this disposable fixture, then restore the prior canonical cut.
  await resetSchema();
  expect(
    await restoreCanonical(
      env.DB,
      { manifest, chunks: portableChunks },
      'subject-a',
    ),
  ).toMatchObject({
    result: 'PASS',
    active_sessions_restored: 0,
    active_worker_credentials_restored: 0,
  });
  expect(
    await env.DB.prepare('SELECT enabled FROM sources').first('enabled'),
  ).toBe(1);
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM owner_sessions').first('n'),
  ).toBe(0);
});
it('barrier timeout resumes writes and can never produce a verified manifest', async () => {
  const backup = new CoreBackup(env.DB, await fixtureOwner()),
    started = await backup.begin();
  await env.DB.prepare(
    "UPDATE maintenance_state SET barrier_until='2000-01-01T00:00:00.000Z'",
  ).run();
  await expect(backup.chunk(started.backup_id, 'sources', 0)).rejects.toThrow(
    'BACKUP_EXPIRED_OR_CLOSED',
  );
  await expect(backup.complete(started.backup_id)).rejects.toThrow(
    'BACKUP_EXPIRED_OR_CLOSED',
  );
  await expect(backup.manifest(started.backup_id)).rejects.toThrow(
    'BACKUP_NOT_VERIFIED',
  );
  await env.DB.prepare(
    "INSERT INTO audit_events VALUES('fixture-event','a','a','AFTER_TIMEOUT',NULL,'fixture','2026-10-05T00:00:00Z')",
  ).run();
  await backup.abort(started.backup_id);
});
