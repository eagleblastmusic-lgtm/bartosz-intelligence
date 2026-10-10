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
import { KnowledgeOrganization } from '../../packages/core/src/knowledge/organization.js';
import { SearchIndex } from '../../packages/core/src/knowledge/search-index.js';
import { SemanticProfiles } from '../../packages/core/src/registry/semantic-profiles.js';
import {
  semanticModules,
  type SemanticProfile,
} from '../../packages/core/src/ai/semantic-profile.js';
import registryBundle from '../../config/registry/master-bundle.json';
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync('db/migrations')
    .filter((name) => name.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync('db/migrations/' + name, 'utf8'));
  return { sqlite, db: sqliteAdapter(sqlite) };
}
it('rejects persisted content drift even when table counts and foreign keys match', async () => {
  const source = database(),
    target = database(),
    now = new Date().toISOString();
  try {
    source.sqlite
      .prepare('INSERT INTO owner_users VALUES(?,?,?,?,?)')
      .run('a', 'https://accounts.google.com', 'subject-a', 1, now);
    source.sqlite
      .prepare('INSERT INTO owner_sessions VALUES(?,?,?,?,?,NULL)')
      .run('fixture-session', 'a', 'fixture-csrf', now, '2099-01-01T00:00:00Z');
    source.sqlite
      .prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)')
      .run('audit-a', 'a', 'a', 'ORIGINAL', null, 'correlation', now);
    const owner = await AccessContext.owner(source.db, 'fixture-session', now);
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
    const manifest = await backup.complete(started.backup_id);
    target.sqlite.exec(
      "CREATE TRIGGER isolated_corruption AFTER INSERT ON audit_events BEGIN UPDATE audit_events SET event_type='CORRUPTED' WHERE event_id=NEW.event_id; END",
    );
    await expect(
      restoreCanonical(target.db, { manifest, chunks }, 'subject-a'),
    ).rejects.toThrow('RESTORE_CONTENT_MISMATCH');
    expect(
      target.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get()?.n,
    ).toBe(1);
    expect(target.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    source.sqlite.close();
    target.sqlite.close();
  }
});
it('restores an explicitly selected format 2 corpus above the measured production copy while retaining format 1 limits', async () => {
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
    const payload = JSON.stringify({ synthetic: 'x'.repeat(70000) }),
      hash = await sha256(payload);
    const insert = source.sqlite.prepare(
      'INSERT INTO config_versions VALUES(?,?,?,?,?,?)',
    );
    for (let index = 0; index < 180; index++)
      insert.run(
        'synthetic-' + index,
        'a',
        1,
        payload,
        hash,
        now.toISOString(),
      );
    const backup = new CoreBackup(source.db, owner);
    const pilot = await backup.begin();
    await expect(
      backup.chunk(pilot.backup_id, 'config_versions', 0),
    ).rejects.toThrow('BACKUP_ROW_TOO_LARGE');
    await backup.abort(pilot.backup_id);
    const extended = await backup.begin(2);
    const chunks = [];
    for (const table of backupTables) {
      let cursor: number | null = 0;
      do {
        const chunk = await backup.chunk(
          extended.backup_id,
          table,
          cursor,
          100,
        );
        chunks.push(chunk);
        cursor = chunk.next_cursor;
      } while (cursor !== null);
    }
    const manifest = await backup.complete(extended.backup_id);
    expect(manifest.version).toBe(2);
    expect(chunks.length).toBeGreaterThan(200);
    const verified = await verifyPortableBackup({ manifest, chunks });
    expect(verified.bytes).toBeGreaterThan(11954905);
    expect(verified.bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    await restoreCanonical(target.db, { manifest, chunks }, 'subject-a');
    expect(
      target.sqlite.prepare('SELECT COUNT(*) n FROM config_versions').get()?.n,
    ).toBe(180);
    const restored = target.sqlite
      .prepare('SELECT payload_json FROM config_versions WHERE config_id=?')
      .get('synthetic-179');
    expect(await sha256(String(restored?.payload_json))).toBe(hash);
    expect(
      target.sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check,
    ).toBe('ok');
    expect(target.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      target.sqlite.prepare('SELECT COUNT(*) n FROM owner_sessions').get()?.n,
    ).toBe(0);
  } finally {
    source.sqlite.close();
    target.sqlite.close();
  }
});
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
    await new SemanticProfiles(source.db, owner).save(
      {
        profile_id: 'restore-profile',
        revision: 1,
        name: 'Restore profile',
        reason: 'Restore proof',
        config: {
          mode: 'CUSTOM',
          modules: Object.fromEntries(
            semanticModules.map((key) => [key, key === 'summary']),
          ) as SemanticProfile['modules'],
          translation: 'NONE',
          history: false,
          second_pass: null,
          validation_pass: null,
        },
      },
      registryBundle,
      now,
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
    const organization = new KnowledgeOrganization(source.db, owner),
      space_id = crypto.randomUUID();
    await organization.space(
      {
        space_id,
        name: 'Restore research',
        active: true,
        expected_revision: 0,
        mutation_id: crypto.randomUUID(),
      },
      now,
    );
    await organization.membership(
      {
        item_id: item.item_id,
        space_id,
        active: true,
        expected_revision: 0,
        mutation_id: crypto.randomUUID(),
      },
      now,
    );
    await organization.review(
      {
        item_id: item.item_id,
        action: 'SAVE',
        reviewed_run_id: null,
        expected_revision: 0,
        mutation_id: crypto.randomUUID(),
      },
      now,
    );
    const observation = JSON.stringify({
      observation_id: 'restore-note-observation',
      kind: 'CLAIM',
      content_pl: 'Restore relation fixture',
    });
    await source.db
      .prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?)')
      .bind(
        'a',
        'restore-note-observation',
        'accepted-fixture-run',
        'CLAIM',
        observation,
        await sha256(observation),
        now.toISOString(),
      )
      .run();
    await organization.insight(
      {
        item_id: item.item_id,
        insight_id: crypto.randomUUID(),
        text: 'Authored restore note',
        active: true,
        observation_ids: ['restore-note-observation'],
        expected_revision: 0,
        mutation_id: crypto.randomUUID(),
      },
      now,
    );
    const searchIndex = new SearchIndex(source.db, owner);
    for (let step = 0; step < 100; step++) {
      const result = await searchIndex.step(now);
      if (!result.progressed) break;
    }
    const searchBefore = source.sqlite
      .prepare(
        'SELECT doc_id,parent_id,text,content_hash FROM search_documents ORDER BY doc_id',
      )
      .all();
    expect(searchBefore.length).toBeGreaterThan(0);
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
    // Qualified additive retention upgrade also restores the old inventory.
    const legacy = structuredClone(portable);
    legacy.manifest.migrations = legacy.manifest.migrations.slice(0, 36);
    for (const table of [
      'retention_settings',
      'daily_export_members',
      'retention_items',
      'transcript_archive_folders',
      'transcript_archives',
    ]) {
      delete legacy.manifest.tables[table];
      legacy.chunks = legacy.chunks.filter((chunk) => chunk.table !== table);
    }
    const { sha256: ignoredLegacyHash, ...legacyBody } = legacy.manifest;
    void ignoredLegacyHash;
    legacy.manifest.sha256 = await sha256(JSON.stringify(legacyBody));
    expect((await verifyPortableBackup(legacy)).rows).toBe(
      (await verifyPortableBackup(portable)).rows,
    );
    const retentionBackup = structuredClone(portable);
    retentionBackup.manifest.migrations =
      retentionBackup.manifest.migrations.slice(0, 37);
    for (const table of ['transcript_archive_folders', 'transcript_archives']) {
      delete retentionBackup.manifest.tables[table];
      retentionBackup.chunks = retentionBackup.chunks.filter(
        (chunk) => chunk.table !== table,
      );
    }
    const { sha256: oldHash, ...retentionBody } = retentionBackup.manifest;
    void oldHash;
    retentionBackup.manifest.sha256 = await sha256(
      JSON.stringify(retentionBody),
    );
    expect((await verifyPortableBackup(retentionBackup)).rows).toBe(
      (await verifyPortableBackup(portable)).rows,
    );
    const appendBackup = structuredClone(retentionBackup);
    appendBackup.manifest.migrations = portable.manifest.migrations.slice(
      0,
      38,
    );
    const { sha256: appendHash, ...appendBody } = appendBackup.manifest;
    void appendHash;
    appendBackup.manifest.sha256 = await sha256(JSON.stringify(appendBody));
    expect((await verifyPortableBackup(appendBackup)).rows).toBe(
      (await verifyPortableBackup(portable)).rows,
    );
    const drifted = structuredClone(legacy);
    drifted.manifest.migrations[0]!.sha256 = '0'.repeat(64);
    const { sha256: ignoredDriftHash, ...driftBody } = drifted.manifest;
    void ignoredDriftHash;
    drifted.manifest.sha256 = await sha256(JSON.stringify(driftBody));
    await expect(verifyPortableBackup(drifted)).rejects.toThrow(
      'BACKUP_MANIFEST_MISMATCH',
    );
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
      await restoreCanonical(target.db, legacy, 'subject-a'),
    ).toMatchObject({ result: 'PASS' });
    expect(
      target.sqlite.prepare('SELECT COUNT(*) n FROM search_documents').get()!.n,
    ).toBe(0);
    target.sqlite
      .prepare('INSERT INTO owner_sessions VALUES(?,?,?,?,?,NULL)')
      .run(
        'restored-search-session',
        'a',
        'restored-csrf',
        now.toISOString(),
        '2099-01-01T00:00:00Z',
      );
    const restoredOwner = await AccessContext.owner(
      target.db,
      'restored-search-session',
      now.toISOString(),
    );
    const restoredIndex = new SearchIndex(target.db, restoredOwner);
    expect((await restoredIndex.metadata()).freshness).toBe('UNKNOWN');
    for (let step = 0; step < 100; step++) {
      const result = await restoredIndex.step(now);
      if (!result.progressed) break;
    }
    expect(
      target.sqlite
        .prepare(
          'SELECT doc_id,parent_id,text,content_hash FROM search_documents ORDER BY doc_id',
        )
        .all(),
    ).toEqual(searchBefore);
    target.sqlite
      .prepare('DELETE FROM owner_sessions WHERE session_hash=?')
      .run('restored-search-session');
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
      'spaces',
      'item_spaces',
      'review_state',
      'insights',
      'insight_observations',
      'organization_mutations',
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
