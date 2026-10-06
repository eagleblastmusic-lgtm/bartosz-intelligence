import { it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { sqliteAdapter } from '../../tools/db/sqlite-adapter.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { RunRepository } from '../../packages/core/src/jobs/acceptance.js';
import {
  CoreBackup,
  backupTables,
} from '../../packages/core/src/backup/snapshot.js';
import {
  restoreCanonical,
  verifyPortableBackup,
} from '../../packages/core/src/backup/restore.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { EntityKnowledge } from '../../packages/core/src/knowledge/entities.js';
import { EntityIdentity } from '../../packages/core/src/knowledge/identity.js';
import { KnowledgeCorrections } from '../../packages/core/src/knowledge/corrections.js';
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync('db/migrations')
    .filter((name) => name.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync('db/migrations/' + name, 'utf8'));
  return { sqlite, db: sqliteAdapter(sqlite) };
}
it('independent canonical restore preserves cyclic revision refs/origins and invalidates sessions, leases and worker credentials', async () => {
  const source = database(),
    target = database(),
    now = new Date();
  try {
    source.sqlite
      .prepare('INSERT INTO owner_users VALUES(?,?,?,?,?)')
      .run(
        'a',
        'https://accounts.google.com',
        'subject-a',
        1,
        now.toISOString(),
      );
    source.sqlite
      .prepare('INSERT INTO owner_sessions VALUES(?,?,?,?,?,NULL)')
      .run(
        'fixture-session',
        'a',
        'fixture-csrf',
        now.toISOString(),
        '2099-01-01T00:00:00Z',
      );
    const owner = await AccessContext.owner(
      source.db,
      'fixture-session',
      now.toISOString(),
    );
    const channel = (await new SourceRepository(source.db, owner).upsert(
      {
        namespace: 'youtube',
        external_id: 'UC-fixture',
        canonical_locator: 'https://www.youtube.com/channel/fixture',
        title: 'Fixture',
        uploads_playlist_id: 'UU-fixture',
        handle: null,
      },
      now.toISOString(),
    ))!;
    const item = (await new ItemRepository(source.db, owner).upsert(
      channel.source_id,
      {
        namespace: 'youtube',
        external_id: 'fixture0001',
        canonical_url: 'https://www.youtube.com/watch?v=fixture0001',
        title: 'Fixture',
        item_type: 'video',
        published_at: '2026-10-01T00:00:00.000Z',
        publication_provenance: 'fixture',
        availability: 'PUBLIC',
        duration_seconds: 60,
      },
      now.toISOString(),
    ))!;
    const hash = await sha256('fixture-worker-secret');
    source.sqlite
      .prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
      .run(
        'local',
        'a',
        hash,
        '["FETCH_TRANSCRIPT","ANALYZE"]',
        now.toISOString(),
      );
    const job = (await new JobStore(source.db, owner).enqueue(
      {
        item_id: item.item_id,
        source_id: channel.source_id,
        task_type: 'FETCH_TRANSCRIPT',
        input_revision: 'fixture',
        profile_revision: 'economy-1',
        prompt_snapshot_id: null,
        routing_policy_version: 'local-primary-1',
        wire_schema_version: null,
        canonical_schema_version: null,
        enrichment_version: null,
        explicit_run_nonce: '',
        arrival_origin_at: '2026-10-01T00:00:00.000Z',
        origin_kind: 'BACKFILL',
        payload: {},
        priority: 20,
        due_at: now.toISOString(),
      },
      now.toISOString(),
    ))!;
    const worker = await AccessContext.worker(source.db, hash),
      store = new JobStore(source.db, worker),
      lease = (await store.lease(
        job.job_id,
        'FETCH_TRANSCRIPT',
        now,
        'local',
      ))!;
    await store.start(lease, 'FETCH_TRANSCRIPT', now);
    const configPayload = JSON.stringify({
      secret_ref: 'GEMINI_API_KEY',
      paid_services_enabled: false,
    });
    source.sqlite
      .prepare('INSERT INTO config_versions VALUES(?,?,?,?,?,?)')
      .run(
        'runtime',
        'a',
        1,
        configPayload,
        await sha256(configPayload),
        now.toISOString(),
      );
    const analysis = (await new JobStore(source.db, owner).enqueue(
      {
        ...job,
        task_type: 'ANALYZE',
        payload: {},
        explicit_run_nonce: 'accepted-fixture',
      },
      now.toISOString(),
    ))!;
    const analysisLease = (await store.lease(
      analysis.job_id,
      'ANALYZE',
      now,
      'local',
    ))!;
    await store.start(analysisLease, 'ANALYZE', now);
    const runs = new RunRepository(source.db, worker);
    await runs.prepare(
      'accepted-fixture-run',
      analysis.job_id,
      now.toISOString(),
    );
    const selection = await new RunRepository(
      source.db,
      owner,
    ).requestSelection('accepted-fixture-run', item.item_id);
    await runs.complete(
      analysisLease,
      'ANALYZE',
      'accepted-fixture-run',
      await sha256('{}'),
      {},
      selection,
      now,
    );
    source.sqlite
      .prepare('INSERT INTO entities VALUES(?,?,?,?,?,?)')
      .run(
        'a',
        'alias-fixture',
        'Claude',
        'TOOL',
        'UNRESOLVED_LITERAL',
        now.toISOString(),
      );
    const aliasRepository = new EntityKnowledge(source.db, owner);
    const approval = {
      entity_id: 'alias-fixture',
      literal: 'Claude',
      reason: 'Confirmed by owner',
      language: null,
      action: 'APPROVE' as const,
      expected_revision: 0,
      decision_id: crypto.randomUUID(),
    };
    await aliasRepository.decide(approval, now);
    await aliasRepository.decide(
      {
        ...approval,
        action: 'REVOKE',
        expected_revision: 1,
        decision_id: crypto.randomUUID(),
      },
      now,
    );
    source.sqlite
      .prepare('INSERT INTO entities VALUES(?,?,?,?,?,?)')
      .run(
        'a',
        'alias-target',
        'Other literal',
        'TOOL',
        'UNRESOLVED_LITERAL',
        now.toISOString(),
      );
    const identities = new EntityIdentity(source.db, owner);
    const merge = await identities.preview({
      action: 'MERGE',
      source_entity_id: 'alias-fixture',
      target_entity_id: 'alias-target',
      reason: 'Owner verified literal grouping',
    });
    await identities.confirm(merge, now);
    await identities.confirm(
      await identities.undoPreview(
        merge.event_id,
        'Restore original membership',
      ),
      now,
    );
    const corrections = new KnowledgeCorrections(source.db, owner);
    const targetLabel = await corrections.read('ENTITY_LABEL', 'alias-target');
    await corrections.apply(
      {
        target_kind: 'ENTITY_LABEL',
        target_id: 'alias-target',
        expected_revision: 0,
        target_hash: targetLabel.target_hash,
        old_value: targetLabel.original_value,
        new_value: 'Owner label',
        action: 'APPLY',
        reason: 'Owner correction',
        correction_id: crypto.randomUUID(),
      },
      now,
    );
    const backup = new CoreBackup(source.db, owner),
      started = await backup.begin(),
      chunks = [];
    for (const table of backupTables) {
      let cursor: number | null = 0;
      do {
        const chunk = await backup.chunk(started.backup_id, table, cursor);
        chunks.push(chunk);
        cursor = chunk.next_cursor;
      } while (cursor !== null);
    }
    const portable = {
      manifest: await backup.complete(started.backup_id),
      chunks,
    };
    expect(JSON.stringify(portable)).not.toContain('fixture-worker-secret');
    expect(JSON.stringify(portable)).not.toContain('fixture-session');
    expect(JSON.stringify(portable)).not.toContain('subject-a');
    const corrupt = structuredClone(portable);
    corrupt.chunks.find((chunk) => chunk.table === 'items')!.rows[0]!.title =
      'corrupted';
    await expect(verifyPortableBackup(corrupt)).rejects.toThrow(
      'BACKUP_CHUNK_MISMATCH',
    );
    await expect(
      verifyPortableBackup({ ...portable, chunks: portable.chunks.slice(1) }),
    ).rejects.toThrow('BACKUP_INCOMPLETE');
    await expect(
      restoreCanonical(target.db, portable, 'wrong-subject'),
    ).rejects.toThrow('RESTORE_OWNER_BINDING_REQUIRED');
    expect(
      target.sqlite.prepare('SELECT COUNT(*) n FROM owner_users').get()!.n,
    ).toBe(0);
    expect(
      await restoreCanonical(target.db, portable, 'subject-a'),
    ).toMatchObject({ result: 'PASS' });
    expect(
      target.sqlite
        .prepare('SELECT * FROM entity_alias_decisions ORDER BY revision')
        .all(),
    ).toEqual(
      source.sqlite
        .prepare('SELECT * FROM entity_alias_decisions ORDER BY revision')
        .all(),
    );
    for (const table of [
      'entity_identity_events',
      'entity_identity_members',
      'correction_overlays',
    ])
      expect(
        target.sqlite
          .prepare('SELECT * FROM ' + table + ' ORDER BY rowid')
          .all(),
      ).toEqual(
        source.sqlite
          .prepare('SELECT * FROM ' + table + ' ORDER BY rowid')
          .all(),
      );
    expect(
      target.sqlite.prepare('SELECT literal FROM entity_aliases').get()!
        .literal,
    ).toBe('Claude');
    expect(
      target.sqlite.prepare('SELECT * FROM change_log ORDER BY seq').all(),
    ).toEqual(
      source.sqlite.prepare('SELECT * FROM change_log ORDER BY seq').all(),
    );
    const triggers = target.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'projection_invalidate_%' ORDER BY name",
      )
      .all();
    expect(triggers).toEqual(
      source.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'projection_invalidate_%' ORDER BY name",
        )
        .all(),
    );
    expect(
      target.sqlite
        .prepare(
          'SELECT state,lease_owner,lease_until,fencing_token,arrival_origin_at,origin_kind FROM jobs WHERE job_id=?',
        )
        .get(job.job_id),
    ).toMatchObject({
      state: 'RETRY_WAIT',
      lease_owner: null,
      lease_until: null,
      fencing_token: lease.fencing_token + 1,
      arrival_origin_at: '2026-10-01T00:00:00.000Z',
      origin_kind: 'BACKFILL',
    });
    expect(
      target.sqlite.prepare('SELECT current_revision_id FROM items').get()!
        .current_revision_id,
    ).toBe(item.current_revision_id);
    expect(
      target.sqlite.prepare('SELECT COUNT(*) n FROM owner_sessions').get()!.n,
    ).toBe(0);
    expect(
      target.sqlite
        .prepare(
          'SELECT accepted_run_id,requested_run_id,selection_revision FROM active_analysis_selections',
        )
        .get(),
    ).toMatchObject({
      accepted_run_id: 'accepted-fixture-run',
      requested_run_id: 'accepted-fixture-run',
      selection_revision: selection,
    });
    expect(
      target.sqlite
        .prepare(
          "SELECT state FROM analysis_runs WHERE run_id='accepted-fixture-run'",
        )
        .get()!.state,
    ).toBe('ACCEPTED');
    expect(
      target.sqlite.prepare('SELECT payload_json FROM config_versions').get()!
        .payload_json,
    ).toBe(configPayload);
    await expect(AccessContext.worker(target.db, hash)).rejects.toThrow(
      'UNAUTHENTICATED',
    );
    expect(
      target.sqlite.prepare('PRAGMA integrity_check').get()!.integrity_check,
    ).toBe('ok');
    expect(target.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    source.sqlite.close();
    target.sqlite.close();
  }
});
