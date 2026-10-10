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
import { DriveClient } from '../../packages/core/src/drive/client.js';
import { restoreCanonical } from '../../packages/core/src/backup/restore.js';
import type { BackupChunk } from '../../packages/core/src/backup/snapshot.js';
import type { Database } from '../../packages/core/src/db/boundary.js';
beforeEach(resetCore);
it('uses two bounded database round trips per populated chunk and preserves idempotent receipts', async () => {
  const owner = await fixtureOwner();
  const backup = new CoreBackup(env.DB, owner);
  const legacy = await backup.begin();
  await expect(
    backup.chunk(legacy.backup_id, 'owner_users', 0, 100),
  ).rejects.toThrow('INVALID_BACKUP_PAGE_FORMAT');
  await backup.abort(legacy.backup_id);
  const started = await backup.begin(2);
  let batches = 0;
  const counted: Database = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements) {
      batches++;
      return env.DB.batch(statements as D1PreparedStatement[]);
    },
  };
  const bounded = new CoreBackup(counted, owner);
  const first = await bounded.chunk(started.backup_id, 'owner_users', 0, 100);
  expect(first.rows).toHaveLength(1);
  expect(batches).toBe(2);
  expect(await bounded.chunk(started.backup_id, 'owner_users', 0, 100)).toEqual(
    first,
  );
  expect(batches).toBe(4);
  expect(
    await env.DB.prepare(
      'SELECT count(*) n FROM backup_chunks WHERE backup_id=?',
    )
      .bind(started.backup_id)
      .first('n'),
  ).toBe(1);
  await backup.abort(started.backup_id);
});
it('rejects expiry immediately before the batched receipt write without persisting a chunk', async () => {
  const owner = await fixtureOwner();
  const backup = new CoreBackup(env.DB, owner),
    started = await backup.begin(2);
  let committing = false;
  const racing: Database = {
    prepare(sql) {
      if (sql.startsWith('INSERT INTO backup_chunks')) committing = true;
      return env.DB.prepare(sql);
    },
    async batch(statements) {
      if (committing) {
        await env.DB.prepare(
          "UPDATE maintenance_state SET barrier_until='2000-01-01T00:00:00.000Z'",
        ).run();
      }
      return env.DB.batch(statements as D1PreparedStatement[]);
    },
  };
  await expect(
    new CoreBackup(racing, owner).chunk(started.backup_id, 'owner_users', 0),
  ).rejects.toThrow('BACKUP_EXPIRED_OR_CLOSED');
  expect(
    await env.DB.prepare(
      'SELECT count(*) n FROM backup_chunks WHERE backup_id=?',
    )
      .bind(started.backup_id)
      .first('n'),
  ).toBe(0);
  await backup.abort(started.backup_id);
});
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
  const archive = JSON.stringify({ manifest, chunks: portableChunks });
  let uploads = 0;
  const drive = new DriveClient('fixture-token', async (url, options) => {
    if (String(url).includes('/permissions'))
      return Response.json({ permissions: [{ type: 'user', role: 'owner' }] });
    uploads++;
    expect(options?.body).toContain(archive);
    expect(options?.body).not.toContain('ciphertext');
    return Response.json({
      id: 'reserved-backup',
      name: manifest.backup_id + '.canonical.json',
      mimeType: 'application/json',
      parents: ['private-backups'],
    });
  });
  const input = {
    reserved_id: 'reserved-backup',
    root_id: 'private-backups',
    backup_id: manifest.backup_id,
    envelope_json: archive,
  };
  expect((await drive.createCanonicalBackup(input)).id).toBe('reserved-backup');
  const tampered = JSON.parse(archive);
  tampered.chunks[0].rows[0].password = 'fixture-secret';
  await expect(
    drive.createCanonicalBackup({
      ...input,
      envelope_json: JSON.stringify(tampered),
    }),
  ).rejects.toThrow('DRIVE_FORMAT');
  await expect(
    drive.createCanonicalBackup({
      ...input,
      backup_id: '00000000-0000-0000-0000-000000000000',
    }),
  ).rejects.toThrow('DRIVE_FORMAT');
  expect(uploads).toBe(1);
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
