import { it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { sqliteAdapter } from '../../tools/db/sqlite-adapter.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import {
  RetentionCleanup,
  cleanupStages,
} from '../../packages/core/src/retention/cleanup.js';
import {
  CoreBackup,
  backupTables,
} from '../../packages/core/src/backup/snapshot.js';
import {
  restoreCanonical,
  verifyPortableBackup,
} from '../../packages/core/src/backup/restore.js';
import { repairMissingIntents } from '../../packages/core/src/sources/youtube/reconcile.js';
import { CapacityCollection } from '../../packages/core/src/projections/capacity-collection.js';
import { AnalysisJobs } from '../../packages/core/src/ai/jobs.js';
import { DailyProjection } from '../../packages/core/src/projections/daily.js';

function database(path = ':memory:') {
  const initialized = path !== ':memory:' && existsSync(path);
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA foreign_keys=ON');
  if (!initialized)
    for (const name of readdirSync('db/migrations')
      .filter((n) => n.endsWith('.sql'))
      .sort())
      sqlite.exec(readFileSync('db/migrations/' + name, 'utf8'));
  return { sqlite, db: sqliteAdapter(sqlite) };
}
const exported = new Date('2026-10-09T12:00:00.000Z'),
  due = new Date(exported.getTime() + 7 * 86400000);
async function fixture(partial = false, path = ':memory:') {
  const f = database(path),
    { sqlite, db } = f,
    at = exported.toISOString();
  sqlite
    .prepare('INSERT INTO owner_users VALUES(?,?,?,?,?)')
    .run('a', 'https://accounts.google.com', 'subject-a', 1, at);
  sqlite
    .prepare('INSERT INTO owner_sessions VALUES(?,?,?,?,?,NULL)')
    .run('session', 'a', 'csrf', at, '2099-01-01T00:00:00.000Z');
  const owner = await AccessContext.owner(db, 'session', at);
  const source = (await new SourceRepository(db, owner).upsert(
    {
      namespace: 'youtube',
      external_id: 'UC-fixture',
      canonical_locator: 'https://www.youtube.com/channel/UC-fixture',
      title: 'Fixture',
      uploads_playlist_id: 'UU-fixture',
      handle: null,
    },
    at,
  ))!;
  const items = [];
  for (const id of ['videoaaaaaa', 'videobbbbbb']) {
    items.push(
      (await new ItemRepository(db, owner).upsert(
        source.source_id,
        {
          namespace: 'youtube',
          external_id: id,
          canonical_url: 'https://www.youtube.com/watch?v=' + id,
          item_type: 'video',
          title: id,
          published_at: '2026-10-01T00:00:00.000Z',
          publication_provenance: 'videos.snippet.publishedAt',
          availability: 'PUBLIC',
          duration_seconds: 60,
        },
        at,
      ))!,
    );
  }
  const item = items[0]!.item_id,
    other = items[1]!.item_id;
  const body =
    '## Wartościowe polskie streszczenie\nFilm: https://www.youtube.com/watch?v=videoaaaaaa\n';
  const hash = await sha256(body),
    canonicalHash = 'c'.repeat(64);
  sqlite
    .prepare(
      `INSERT INTO jobs(job_id,owner_id,item_id,source_id,task_type,input_revision,profile_revision,routing_policy_version,explicit_run_nonce,dedup_key,state,due_at,priority,arrival_origin_at,origin_kind,payload_json,created_at,updated_at) VALUES('accepted-job','a',?,?,'ANALYZE','input','economy-1','policy','','dedup','SUCCEEDED',?,80,?,'NEW','{"snapshot":{"settings":{"mode":"PRODUCTION"}}}',?,?)`,
    )
    .run(item, source.source_id, at, at, at, at);
  sqlite
    .prepare(
      `INSERT INTO analysis_runs(run_id,owner_id,item_id,job_id,input_snapshot_json,profile_snapshot_json,routing_snapshot_json,state,candidate_hash,outcome_json,created_at,accepted_at) VALUES('run','a',?,'accepted-job','{"source":"large"}','{}','{}','ACCEPTED',?,?,?,?)`,
    )
    .run(
      item,
      await sha256(
        JSON.stringify({
          version: 'intelligence-accepted:1',
          source_artifact_id: 'raw-' + item,
          canonical_hash: canonicalHash,
          view: { status: 'OK', coverage_complete: !partial },
        }),
      ),
      JSON.stringify({
        version: 'intelligence-accepted:1',
        source_artifact_id: 'raw-' + item,
        canonical_hash: canonicalHash,
        view: { status: 'OK', coverage_complete: !partial },
      }),
      at,
      at,
    );
  sqlite
    .prepare(
      "INSERT INTO active_analysis_selections VALUES('a',?,'run',1,'run')",
    )
    .run(item);
  sqlite
    .prepare(
      `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,root_id,root_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','connection','subject-a','client','[]','CONNECTED','root','VERIFIED',1,'receipt',?,?)`,
    )
    .run(at, at);
  sqlite
    .prepare(
      `INSERT INTO daily_export_artifacts VALUES('a','daily','root','2026-10-01',1,0,'FULL',?,?,?,1,'STAGING')`,
    )
    .run(hash, hash, Buffer.byteLength(body));
  sqlite
    .prepare("INSERT INTO daily_export_chunks VALUES('a','daily',0,?,?,?)")
    .run(
      Buffer.byteLength(body),
      hash,
      Buffer.from(body).toString('base64url'),
    );
  sqlite.exec("UPDATE daily_export_artifacts SET state='SEALED'");
  sqlite
    .prepare(
      `INSERT INTO export_state(owner_id,publication_date,destination_key,root_namespace,connection_id,file_id,reserved_remote_id,full_file_hash,revision,mode,rendered_artifact_id) VALUES('a','2026-10-01','drive:root','root','connection','file','file',?,1,'FULL','daily')`,
    )
    .run(hash);
  sqlite
    .prepare(
      "INSERT INTO drive_export_attempts VALUES('a','daily','file',1,'VERIFIED',NULL,'1',?,?)",
    )
    .run(hash, at);
  sqlite
    .prepare("INSERT INTO daily_export_members VALUES('a','daily',?,'run',?)")
    .run(item, canonicalHash);
  sqlite
    .prepare(
      `INSERT INTO retention_items(owner_id,item_id,accepted_run_id,canonical_hash,root_id,publication_date,artifact_id,file_id,remote_version,export_revision,file_hash,verified_at,purge_after,updated_at) VALUES('a',?,'run',?,'root','2026-10-01','daily','file','1',1,?,?,?,?)`,
    )
    .run(item, canonicalHash, hash, at, due.toISOString(), at);
  sqlite
    .prepare(
      "INSERT INTO retention_settings(owner_id,deletion_enabled,approval_reference) VALUES('a',1,'ISOLATED_TEST_ONLY')",
    )
    .run();
  for (const itemId of [item, other]) {
    const id = 'raw-' + itemId,
      rawHash = await sha256('raw');
    sqlite
      .prepare(
        `INSERT INTO artifacts(artifact_id,owner_id,item_id,kind,content_hash,byte_size,chunk_count,schema_version,producer_version,provenance_json,state,created_at,verified_at) VALUES(?,'a',?,'SOURCE_ORIGINAL',?,3,1,'raw:1','fixture','{}','VERIFIED',?,?)`,
      )
      .run(id, itemId, rawHash, at, at);
    sqlite
      .prepare(
        `INSERT INTO artifact_chunks VALUES('a',?,?,0,0,3,?,'local','cmF3')`,
      )
      .run(itemId, id, rawHash);
  }
  const sourceArtifact = String(
    sqlite
      .prepare('SELECT artifact_id FROM artifacts WHERE item_id=?')
      .get(item)!.artifact_id,
  );
  const sourceHash = await sha256('raw');
  sqlite
    .prepare(
      "INSERT INTO transcript_archive_folders VALUES('a','connection','parent','transcripts',?)",
    )
    .run(at);
  sqlite
    .prepare(
      `INSERT INTO transcript_archives(owner_id,item_id,source_artifact_id,segment_map_artifact_id,source_hash,descriptor_json,folder_id,reserved_file_id,content_hash,verified_hash,verified_source_artifact_id,remote_version,verified_at,state,due_at,updated_at) VALUES('a',?,?,'map',?,'{}','transcripts','transcript-file',?,?,?,'1',?,'VERIFIED',?,?)`,
    )
    .run(
      item,
      sourceArtifact,
      sourceHash,
      sourceHash,
      sourceHash,
      sourceArtifact,
      at,
      at,
      at,
    );
  sqlite
    .prepare(
      `INSERT INTO evidence VALUES('a','evidence',?,?,?,0,3,?,'["s1"]','{"quote":"raw"}',NULL,NULL,'NONE',NULL,?)`,
    )
    .run(item, sourceArtifact, sourceHash, sourceHash, at);
  const observation = {
    observation_id: 'observation',
    kind: 'CLAIM',
    content_pl: 'Poprawna treść testowa',
  };
  sqlite
    .prepare(
      "INSERT INTO observations VALUES('a','observation','run','CLAIM',?,?,?)",
    )
    .run(
      JSON.stringify(observation),
      await sha256(JSON.stringify(observation)),
      at,
    );
  sqlite.exec(
    "INSERT INTO analysis_evidence VALUES('a','run','evidence'); INSERT INTO observation_evidence VALUES('a','observation','evidence')",
  );
  const file = {
    id: 'file',
    name: '2026-10-01.md',
    mimeType: 'text/markdown',
    parents: ['root'],
    trashed: false,
    version: '1',
  };
  const client = {
    getFile: async (id?: string) =>
      id === 'transcript-file'
        ? {
            ...file,
            id: 'transcript-file',
            name: 'videoaaaaaa.md',
            parents: ['transcripts'],
          }
        : file,
    readMarkdown: async () => body,
    readTranscriptMarkdown: async () => 'raw',
    verifyPrivateFolder: async () => ({ private_owner_only: true as const }),
  };
  const cleanup = new RetentionCleanup(db, owner);
  return {
    ...f,
    owner,
    item,
    other,
    source,
    body,
    hash,
    file,
    client,
    cleanup,
  };
}
it('retains until verified export plus exactly seven days, dry-run is read-only and deletion defaults off', async () => {
  const f = await fixture();
  try {
    if (process.env.RETENTION_ISOLATED_FIXTURE_PATH) {
      const backup = new CoreBackup(f.db, f.owner),
        started = await backup.begin(2),
        chunks = [];
      for (const table of backupTables) {
        let cursor: number | null = 0;
        do {
          const chunk = await backup.chunk(started.backup_id, table, cursor);
          chunks.push(chunk);
          cursor = chunk.next_cursor;
        } while (cursor !== null);
      }
      writeFileSync(
        process.env.RETENTION_ISOLATED_FIXTURE_PATH,
        JSON.stringify({
          manifest: await backup.complete(started.backup_id),
          chunks,
        }),
        { flag: 'wx' },
      );
    }
    const before = f.sqlite
      .prepare('SELECT COUNT(*) n FROM artifact_chunks')
      .get();
    expect(
      await f.cleanup.step(f.item, f.client, new Date(due.getTime() - 1)),
    ).toMatchObject({ state: 'HELD' });
    expect((await f.cleanup.dryRun(due)).items[0]).toMatchObject({
      eligible_from_database: true,
      destructive_ready: false,
    });
    expect(
      f.sqlite.prepare('SELECT COUNT(*) n FROM artifact_chunks').get(),
    ).toEqual(before);
    f.sqlite.exec('UPDATE retention_settings SET deletion_enabled=0');
    await expect(f.cleanup.step(f.item, f.client, due)).rejects.toThrow(
      'RETENTION_DELETION_NOT_APPROVED',
    );
    f.sqlite.exec('UPDATE retention_settings SET deletion_enabled=1');
    expect(await f.cleanup.step(f.item, f.client, due)).toMatchObject({
      state: 'PROGRESSED',
      table: 'artifact_chunks',
      deleted_rows: 1,
    });
    expect(
      f.sqlite.prepare('SELECT permit_token FROM retention_items').get()
        ?.permit_token,
    ).toBeNull();
  } finally {
    f.sqlite.close();
  }
});
it.each([
  'unfinished',
  'disconnected',
  'hash',
  'version',
  'partial',
  'job',
  'hold',
  'dirty',
  'partial_analysis',
  'correction',
  'transcript_missing',
  'transcript_pending',
  'transcript_source',
  'transcript_hash',
  'transcript_version',
  'transcript_private',
  'new_unarchived_source',
] as const)(
  'holds cleanup for %s without deleting unrelated content',
  async (kind) => {
    const f = await fixture(kind === 'partial_analysis');
    try {
      if (kind === 'transcript_missing')
        f.sqlite.exec('DELETE FROM transcript_archives');
      if (kind === 'transcript_pending')
        f.sqlite.exec("UPDATE transcript_archives SET state='RETRY_WAIT'");
      if (kind === 'transcript_source')
        f.sqlite.exec(
          "UPDATE transcript_archives SET verified_source_artifact_id='unrelated'",
        );
      if (kind === 'new_unarchived_source')
        f.sqlite
          .prepare(
            `INSERT INTO artifacts(artifact_id,owner_id,item_id,kind,content_hash,byte_size,chunk_count,schema_version,producer_version,provenance_json,state,created_at,verified_at) VALUES('new-unarchived','a',?,'SOURCE_ORIGINAL',?,3,1,'raw:1','fixture','{}','VERIFIED',?,?)`,
          )
          .run(
            f.item,
            await sha256('new'),
            due.toISOString(),
            due.toISOString(),
          );
      if (kind === 'unfinished')
        f.sqlite.exec("UPDATE drive_export_attempts SET state='PREPARED'");
      if (kind === 'disconnected')
        f.sqlite.exec(
          "UPDATE drive_connections SET auth_state='REAUTH_REQUIRED'",
        );
      if (kind === 'partial') {
        f.sqlite.exec('DELETE FROM active_analysis_selections');
      }
      if (kind === 'job')
        f.sqlite.exec(
          "INSERT INTO jobs SELECT 'pending',owner_id,item_id,source_id,task_type,input_revision,profile_revision,prompt_snapshot_id,routing_policy_version,wire_schema_version,canonical_schema_version,enrichment_version,'pending','pending','PENDING',NULL,due_at,priority,0,NULL,NULL,0,NULL,arrival_origin_at,origin_kind,'{}',created_at,updated_at FROM jobs",
        );
      if (kind === 'hold') await f.cleanup.hold(f.item, 'RECOVERY_HOLD', due);
      if (kind === 'dirty')
        f.sqlite.exec('UPDATE export_state SET dirty_seq=10');
      if (kind === 'correction')
        f.sqlite
          .prepare(
            "INSERT INTO correction_overlays VALUES('a','correction','OBSERVATION_TEXT','observation',1,?,'Poprawna treść testowa','Poprawna treść testowa','Korekta','APPLY','fixture','a',?,?)",
          )
          .run(
            String(
              f.sqlite
                .prepare(
                  "SELECT row_hash FROM observations WHERE observation_id='observation'",
                )
                .get()!.row_hash,
            ),
            'd'.repeat(64),
            due.toISOString(),
          );
      const client =
        kind === 'transcript_hash'
          ? { ...f.client, readTranscriptMarkdown: async () => 'wrong' }
          : kind === 'transcript_version'
            ? {
                ...f.client,
                getFile: async (id?: string) =>
                  id === 'transcript-file'
                    ? { ...(await f.client.getFile(id)), version: '2' }
                    : f.file,
              }
            : kind === 'transcript_private'
              ? {
                  ...f.client,
                  verifyPrivateFolder: async () => {
                    throw new Error('DENIED');
                  },
                }
              : kind === 'hash'
                ? {
                    ...f.client,
                    readMarkdown: async () => f.body + 'corruption',
                  }
                : kind === 'version'
                  ? {
                      ...f.client,
                      getFile: async () => ({ ...f.file, version: '2' }),
                    }
                  : f.client;
      expect(await f.cleanup.step(f.item, client, due)).toMatchObject({
        state: 'HELD',
        deleted_rows: 0,
      });
      expect(
        f.sqlite.prepare('SELECT COUNT(*) n FROM artifact_chunks').get()?.n,
      ).toBe(2);
    } finally {
      f.sqlite.close();
    }
  },
);
it('rejects unavailable Drive and a concurrent database change after readback', async () => {
  const f = await fixture();
  try {
    expect(
      await f.cleanup.step(
        f.item,
        {
          ...f.client,
          getFile: async () => {
            throw Error('unavailable');
          },
        },
        due,
      ),
    ).toMatchObject({ state: 'HELD' });
    const client = {
      ...f.client,
      readMarkdown: async () => {
        await f.cleanup.hold(f.item, 'CORRECTION_HOLD', due);
        return f.body;
      },
    };
    expect(await f.cleanup.step(f.item, client, due)).toMatchObject({
      state: 'HELD',
    });
    expect(
      f.sqlite.prepare('SELECT COUNT(*) n FROM artifact_chunks').get()?.n,
    ).toBe(2);
  } finally {
    f.sqlite.close();
  }
});
it('keeps batches at 25 rows and resumes a checkpoint after closing and reopening persistent SQLite', async () => {
  const path =
    '.local/tests/retention-restart-' + crypto.randomUUID() + '.sqlite';
  const f = await fixture(false, path);
  const body = 'raw'.repeat(60),
    id = crypto.randomUUID(),
    at = exported.toISOString(),
    hash = await sha256(body),
    partHash = await sha256('raw');
  f.sqlite
    .prepare(
      `INSERT INTO artifacts(artifact_id,owner_id,item_id,kind,content_hash,byte_size,chunk_count,schema_version,producer_version,provenance_json,state,created_at,verified_at) VALUES(?,'a',?,'RAW',?,180,60,'raw:1','batch-fixture','{}','VERIFIED',?,?)`,
    )
    .run(id, f.item, hash, at, at);
  for (let n = 0; n < 60; n++)
    f.sqlite
      .prepare(
        "INSERT INTO artifact_chunks VALUES('a',?,?,?,?,3,?,'local','cmF3')",
      )
      .run(f.item, id, n, n * 3, partHash);
  expect(await f.cleanup.step(f.item, f.client, due)).toMatchObject({
    state: 'PROGRESSED',
    deleted_rows: 25,
  });
  expect(
    f.sqlite.prepare('SELECT phase,step FROM retention_items').get(),
  ).toMatchObject({ phase: 'PRUNING', step: 0 });
  f.sqlite.close();
  const reopened = database(path);
  try {
    const owner = await AccessContext.owner(
      reopened.db,
      'session',
      due.toISOString(),
    );
    const cleanup = new RetentionCleanup(reopened.db, owner);
    expect(await cleanup.step(f.item, f.client, due)).toMatchObject({
      deleted_rows: 25,
    });
    expect(await cleanup.step(f.item, f.client, due)).toMatchObject({
      deleted_rows: 11,
    });
    expect(
      reopened.sqlite
        .prepare('SELECT step,deleted_rows FROM retention_items')
        .get(),
    ).toMatchObject({ step: 1, deleted_rows: 61 });
    expect(
      reopened.sqlite
        .prepare('SELECT COUNT(*) n FROM artifact_chunks WHERE item_id=?')
        .get(f.other)?.n,
    ).toBe(1);
  } finally {
    reopened.sqlite.close();
  }
});
it('rolls back an interrupted batch, resumes with a new instance, preserves dedup and restores minimal state', async () => {
  const f = await fixture(),
    target = database();
  try {
    // Fault occurs after the actual delete inside the atomic transaction.
    f.sqlite.exec(
      "CREATE TRIGGER test_cleanup_fault AFTER DELETE ON artifact_chunks BEGIN SELECT RAISE(ABORT,'INJECTED_CRASH'); END",
    );
    await expect(f.cleanup.step(f.item, f.client, due)).rejects.toThrow(
      'INJECTED_CRASH',
    );
    expect(
      f.sqlite.prepare('SELECT phase,permit_token FROM retention_items').get(),
    ).toMatchObject({ phase: 'WAITING', permit_token: null });
    expect(
      f.sqlite.prepare('SELECT COUNT(*) n FROM artifact_chunks').get()?.n,
    ).toBe(2);
    f.sqlite.exec('DROP TRIGGER test_cleanup_fault');
    for (let step = 0; step < cleanupStages.length + 10; step++) {
      const result = await new RetentionCleanup(f.db, f.owner).step(
        f.item,
        f.client,
        due,
      );
      if (result.state === 'HELD') break;
    }
    expect(
      f.sqlite
        .prepare('SELECT phase,deleted_rows,permit_token FROM retention_items')
        .get(),
    ).toMatchObject({ phase: 'COMPLETE', permit_token: null });
    expect(
      f.sqlite
        .prepare('SELECT COUNT(*) n FROM artifact_chunks WHERE item_id=?')
        .get(f.other)?.n,
    ).toBe(1);
    expect(
      f.sqlite
        .prepare('SELECT COUNT(*) n FROM artifact_chunks WHERE item_id=?')
        .get(f.item)?.n,
    ).toBe(0);
    expect(
      f.sqlite.prepare('SELECT COUNT(*) n FROM daily_export_chunks').get()?.n,
    ).toBe(0);
    expect(
      f.sqlite.prepare('SELECT dedup_key,payload_json,state FROM jobs').get(),
    ).toMatchObject({
      dedup_key: 'dedup',
      payload_json: '{}',
      state: 'SUCCEEDED',
    });
    expect(
      f.sqlite.prepare('SELECT outcome_json FROM analysis_runs').get()
        ?.outcome_json,
    ).toBe('{"version":"intelligence-archived:1"}');
    expect(await f.cleanup.step(f.item, f.client, due)).toMatchObject({
      state: 'HELD',
      deleted_rows: 0,
    });
    expect(
      (await new DailyProjection(f.db, f.owner).detail(f.item)).archive,
    ).toMatchObject({ file_id: 'file', phase: 'COMPLETE' });
    await expect(
      new DailyProjection(f.db, f.owner).canonicalDescriptor(f.item, 'run'),
    ).rejects.toThrow('ARCHIVED_ITEM_REQUIRES_RECOVERY');
    await repairMissingIntents(f.db, due, 5);
    expect(
      f.sqlite
        .prepare('SELECT COUNT(*) n FROM jobs WHERE item_id=?')
        .get(f.item)?.n,
    ).toBe(1);
    expect(() => f.sqlite.exec('UPDATE export_state SET revision=2')).toThrow(
      'ARCHIVED_REPORT_REQUIRES_RECOVERY',
    );
    const capture = new CoreBackup(f.db, f.owner),
      started = await capture.begin(2),
      chunks = [];
    for (const table of backupTables) {
      let cursor: number | null = 0;
      do {
        const chunk = await capture.chunk(started.backup_id, table, cursor);
        chunks.push(chunk);
        cursor = chunk.next_cursor;
      } while (cursor !== null);
    }
    const portable = {
      manifest: await capture.complete(started.backup_id),
      chunks,
    };
    expect((await verifyPortableBackup(portable)).rows).toBeGreaterThan(0);
    await restoreCanonical(target.db, portable, 'subject-a');
    expect(
      target.sqlite.prepare('SELECT phase,file_id FROM retention_items').get(),
    ).toMatchObject({ phase: 'COMPLETE', file_id: 'file' });
    expect(
      target.sqlite
        .prepare(
          'SELECT deletion_enabled,approval_reference FROM retention_settings',
        )
        .get(),
    ).toMatchObject({ deletion_enabled: 0, approval_reference: null });
    expect(
      target.sqlite
        .prepare(
          'SELECT reserved_file_id,verified_hash,state FROM transcript_archives',
        )
        .get(),
    ).toMatchObject({
      reserved_file_id: 'transcript-file',
      verified_hash: await sha256('raw'),
      state: 'VERIFIED',
    });
    expect(
      target.sqlite
        .prepare('SELECT private_verified_at FROM transcript_archive_folders')
        .get(),
    ).toMatchObject({ private_verified_at: null });
    expect(target.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    f.sqlite.close();
    target.sqlite.close();
  }
}, 15000);

it('preserves Gate C measurement facts and refuses reanalysis after purging source bytes', async () => {
  const f = await fixture();
  try {
    const at = exported.toISOString(),
      sourceId = String(
        f.sqlite
          .prepare('SELECT source_id FROM items WHERE item_id=?')
          .get(f.item)!.source_id,
      );
    f.sqlite
      .prepare(
        `INSERT INTO jobs(job_id,owner_id,item_id,source_id,task_type,input_revision,profile_revision,routing_policy_version,explicit_run_nonce,dedup_key,state,due_at,priority,arrival_origin_at,origin_kind,payload_json,created_at,updated_at) VALUES('source-job','a',?,?,'FETCH_TRANSCRIPT','input','economy-1','policy','','source-dedup','SUCCEEDED',?,80,?,'NEW','{}',?,?)`,
      )
      .run(f.item, sourceId, at, at, '2026-10-08T12:00:00.000Z', at);
    const outcome = JSON.stringify({
      version: 'transcript-source:1',
      source_artifact_id: 'raw-' + f.item,
      source_hash: await sha256('raw'),
      authority: { language_code: 'pl', authority_confidence: 'CONFIRMED' },
    });
    f.sqlite
      .prepare(
        `INSERT INTO analysis_runs(run_id,owner_id,item_id,job_id,input_snapshot_json,profile_snapshot_json,routing_snapshot_json,state,candidate_hash,outcome_json,created_at,accepted_at) VALUES('source-run','a',?,'source-job','{}','{}','{}','ACCEPTED',?,?,?,?)`,
      )
      .run(f.item, await sha256(outcome), outcome, at, at);
    const collection = new CapacityCollection(f.db, f.owner);
    const before = (await collection.page(5, 'test-secret', due)).cases.find(
      (r) => r.item_id === f.item,
    )!;
    expect(before).toMatchObject({
      source_run_id: 'source-run',
      source_bytes: 3,
      source_authority: 'CONFIRMED',
      accepted_effect_id: 'run',
      job_id: 'accepted-job',
    });
    for (let n = 0; n < cleanupStages.length + 5; n++)
      await f.cleanup.step(f.item, f.client, due);
    const after = (await collection.page(5, 'test-secret', due)).cases.find(
      (r) => r.item_id === f.item,
    )!;
    expect(after).toEqual(before);
    await expect(
      new AnalysisJobs(f.db, f.owner).sourceForOwner('source-run'),
    ).rejects.toThrow('ARCHIVED_ITEM_REQUIRES_RECOVERY');
    expect(
      f.sqlite
        .prepare('SELECT length(operational_json) n FROM retention_items')
        .get()?.n,
    ).toBeLessThan(8192);
  } finally {
    f.sqlite.close();
  }
});
