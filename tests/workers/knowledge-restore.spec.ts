import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import {
  resetCore,
  resetSchema,
  fixtureOwner,
  fixtureNow,
} from './core-fixture.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { EntityKnowledge } from '../../packages/core/src/knowledge/entities.js';
import { EntityIdentity } from '../../packages/core/src/knowledge/identity.js';
import { KnowledgeCorrections } from '../../packages/core/src/knowledge/corrections.js';
import { KnowledgeOrganization } from '../../packages/core/src/knowledge/organization.js';
import { SearchIndex } from '../../packages/core/src/knowledge/search-index.js';
import { SemanticProfiles } from '../../packages/core/src/registry/semantic-profiles.js';
import { PromptRegistry } from '../../packages/core/src/registry/store.js';
import { PromptDrafts } from '../../packages/core/src/registry/draft.js';
import { LabQuotaPolicies } from '../../packages/core/src/registry/lab-quota.js';
import { semanticModules } from '../../packages/core/src/ai/semantic-profile.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { ArtifactRepository } from '../../packages/core/src/artifacts/store.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import { buildEvidence } from '../../packages/core/src/ai/enrichment/evidence.js';
import {
  CoreBackup,
  backupTables,
  type BackupChunk,
} from '../../packages/core/src/backup/snapshot.js';
import { restoreCanonical } from '../../packages/core/src/backup/restore.js';
import bundle from '../../config/registry/master-bundle.json';

beforeEach(resetCore);
it('restores Knowledge history and registry on D1, rebuilds identical FTS, and can undo restored identity events', async () => {
  const owner = await fixtureOwner(),
    at = fixtureNow.toISOString();
  const source = (await new SourceRepository(env.DB, owner).upsert(
    {
      namespace: 'youtube',
      external_id: 'UC-restore',
      uploads_playlist_id: 'UU-restore',
      canonical_locator: 'https://www.youtube.com/channel/restore',
      title: 'Restore source',
      handle: null,
    },
    at,
  ))!;
  const item = (await new ItemRepository(env.DB, owner).upsert(
    source.source_id,
    {
      namespace: 'youtube',
      external_id: 'restore0001',
      canonical_url: 'https://www.youtube.com/watch?v=restore0001',
      title: 'Restore knowledge',
      item_type: 'video',
      published_at: at,
      publication_provenance: 'FIXTURE',
      availability: 'PUBLIC',
      duration_seconds: 60,
    },
    at,
  ))!;
  const job = (await new JobStore(env.DB, owner).enqueue(
    {
      item_id: item.item_id,
      source_id: source.source_id,
      task_type: 'ANALYZE',
      input_revision: 'fixture',
      profile_revision: 'fixture',
      prompt_snapshot_id: null,
      routing_policy_version: 'local',
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: at,
      origin_kind: 'NEW',
      payload: {},
      priority: 80,
      due_at: at,
    },
    at,
  ))!;
  // Restore-only fixture, not real provider output or a quality approval.
  await env.DB.prepare(
    "INSERT INTO analysis_runs(run_id,owner_id,item_id,job_id,input_snapshot_json,profile_snapshot_json,routing_snapshot_json,state,created_at) VALUES('restore-run','a',?,?,'{}','{}','{}','ACCEPTED',?)",
  )
    .bind(item.item_id, job.job_id, at)
    .run();
  await env.DB.prepare(
    'INSERT INTO active_analysis_selections VALUES(?,?,?,?,?)',
  )
    .bind('a', item.item_id, 'restore-run', 1, 'restore-run')
    .run();
  const observation = JSON.stringify({
    observation_id: 'restore-observation',
    kind: 'CLAIM',
    content_pl: 'Source-backed fixture statement',
  });
  await env.DB.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?)')
    .bind(
      'a',
      'restore-observation',
      'restore-run',
      'CLAIM',
      observation,
      await sha256(observation),
      at,
    )
    .run();
  for (const id of ['left', 'right'])
    await env.DB.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?)')
      .bind('a', id, id, 'TOOL', 'UNRESOLVED_LITERAL', at)
      .run();
  const workerHash = await sha256('restore-fixture-worker');
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind('restore-worker', 'a', workerHash, '["ANALYZE"]', at)
    .run();
  const worker = await AccessContext.worker(env.DB, workerHash),
    jobs = new JobStore(env.DB, worker);
  const lease = (await jobs.lease(job.job_id, 'ANALYZE', fixtureNow, 'local'))!;
  await jobs.start(lease, 'ANALYZE', fixtureNow);
  const sourceText = 'I did not adopt Żółć 🧠.',
    sourceHash = await sha256(sourceText);
  const artifacts = new ArtifactRepository(env.DB, worker);
  const artifact = await artifacts.begin(
    {
      item_id: item.item_id,
      kind: 'SOURCE_ORIGINAL',
      content_hash: sourceHash,
      byte_size: new TextEncoder().encode(sourceText).byteLength,
      chunk_count: 1,
      schema_version: 'decoded-cue-text:1',
      producer_version: 'restore-fixture:1',
      provenance: { fixture: true },
      original_ref: null,
    },
    lease,
    'ANALYZE',
    fixtureNow,
  );
  await artifacts.writeChunk(
    artifact.artifact_id,
    0,
    0,
    new TextEncoder().encode(sourceText),
    lease,
    'ANALYZE',
    fixtureNow,
  );
  await artifacts.verifyLocal(
    artifact.artifact_id,
    lease,
    'ANALYZE',
    fixtureNow,
    'local',
  );
  const normalized = await normalizeTranscript(
    sourceHash,
    [
      {
        upstream_index: 0,
        text: sourceText,
        start_ms: null,
        end_ms: null,
        speaker_label: null,
      },
    ],
    'NONE',
  );
  const [proof] = await buildEvidence({
    owner_id: 'a',
    source_artifact_id: artifact.artifact_id,
    source_text: sourceText,
    manifest: normalized.manifest,
    manifest_hash: normalized.manifest_hash,
    video_url: 'https://www.youtube.com/watch?v=restore0001',
    segment_refs: ['s1'],
  });
  const ev = proof!.canonical,
    anchor = proof!.anchor_snapshot;
  await env.DB.prepare(
    'INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      'a',
      ev.evidence_id,
      item.item_id,
      artifact.artifact_id,
      sourceHash,
      anchor.source_start,
      anchor.source_end,
      ev.quote_hash,
      JSON.stringify(ev.segment_ids),
      JSON.stringify(anchor),
      ev.start_ms,
      ev.end_ms,
      ev.timestamp_precision,
      ev.timestamp_url,
      at,
    )
    .run();
  await env.DB.prepare('INSERT INTO analysis_evidence VALUES(?,?,?)')
    .bind('a', 'restore-run', ev.evidence_id)
    .run();
  await env.DB.prepare('INSERT INTO observation_evidence VALUES(?,?,?)')
    .bind('a', 'restore-observation', ev.evidence_id)
    .run();
  await env.DB.prepare('INSERT INTO observation_entities VALUES(?,?,?,?)')
    .bind('a', 'restore-observation', 'left', 'MENTION')
    .run();
  const aliases = new EntityKnowledge(env.DB, owner);
  const alias = {
    entity_id: 'left',
    literal: 'Literal alias',
    language: null,
    reason: 'Fixture owner decision',
    decision_id: crypto.randomUUID(),
    expected_revision: 0,
    action: 'APPROVE' as const,
  };
  await aliases.decide(alias, fixtureNow);
  await aliases.decide(
    {
      ...alias,
      expected_revision: 1,
      action: 'REVOKE',
      decision_id: crypto.randomUUID(),
    },
    fixtureNow,
  );
  const identity = new EntityIdentity(env.DB, owner);
  const merge = await identity.preview({
    action: 'MERGE',
    source_entity_id: 'left',
    target_entity_id: 'right',
    reason: 'Fixture grouping',
  });
  await identity.confirm(merge, fixtureNow);
  const corrections = new KnowledgeCorrections(env.DB, owner);
  const label = await corrections.read('ENTITY_LABEL', 'right');
  await corrections.apply(
    {
      target_kind: 'ENTITY_LABEL',
      target_id: 'right',
      expected_revision: 0,
      target_hash: label.target_hash,
      old_value: label.original_value,
      new_value: 'Corrected label',
      action: 'APPLY',
      reason: 'Fixture correction',
      correction_id: crypto.randomUUID(),
    },
    fixtureNow,
  );
  const organization = new KnowledgeOrganization(env.DB, owner),
    space = crypto.randomUUID();
  await organization.space(
    {
      space_id: space,
      name: 'Restore space',
      active: true,
      expected_revision: 0,
      mutation_id: crypto.randomUUID(),
    },
    fixtureNow,
  );
  await organization.membership(
    {
      space_id: space,
      item_id: item.item_id,
      active: true,
      expected_revision: 0,
      mutation_id: crypto.randomUUID(),
    },
    fixtureNow,
  );
  await organization.review(
    {
      item_id: item.item_id,
      action: 'SAVE',
      reviewed_run_id: null,
      expected_revision: 0,
      mutation_id: crypto.randomUUID(),
    },
    fixtureNow,
  );
  await organization.insight(
    {
      item_id: item.item_id,
      insight_id: crypto.randomUUID(),
      text: 'Authored fixture note',
      active: true,
      observation_ids: ['restore-observation'],
      expected_revision: 0,
      mutation_id: crypto.randomUUID(),
    },
    fixtureNow,
  );
  await new PromptRegistry(env.DB, owner).importBundle(bundle, fixtureNow);
  const economy = bundle.prompts.find(
    (row) => row.id === 'ECONOMY_ANALYSIS_V1',
  )!;
  await new PromptDrafts(env.DB, owner).create(
    {
      prompt_id: economy.id,
      base_version: 2,
      expected_latest_version: 2,
      text: economy.text + '\nRestore-only draft.',
      reason: 'Restore fixture',
    },
    fixtureNow,
  );
  await new SemanticProfiles(env.DB, owner).save(
    {
      profile_id: 'restore-custom',
      revision: 1,
      name: 'Restore Custom',
      reason: 'Restore fixture',
      config: {
        mode: 'CUSTOM',
        modules: Object.fromEntries(
          semanticModules.map((key) => [key, key === 'summary']),
        ),
        translation: 'NONE',
        history: false,
        second_pass: null,
        validation_pass: null,
      },
    },
    bundle,
    fixtureNow,
  );
  // Lab policy is immutable configuration and must survive without opening paid routes.
  await new LabQuotaPolicies(env.DB, owner).save(
    {
      version: 'lab-quota:1',
      account_key: 'fixture-account',
      model: 'gemini-3.8-flash',
      daily_requests: 0,
      normal_headroom: { RPM: 1, RPD: 1, INPUT_TPM: 1 },
    },
    0,
    'Restore paused Lab',
    fixtureNow,
  );

  const index = new SearchIndex(env.DB, owner);
  for (let step = 0; step < 100; step++)
    if (!(await index.step(fixtureNow)).progressed) break;
  const searchBefore = (
    await env.DB.prepare(
      'SELECT doc_id,parent_id,text,content_hash FROM search_documents ORDER BY doc_id',
    ).all()
  ).results;
  expect(searchBefore.length).toBeGreaterThan(0);
  const preserved = [
    'schema_versions',
    'prompt_versions',
    'semantic_profile_versions',
    'config_versions',
    'audit_events',
    'items',
    'item_revisions',
    'analysis_runs',
    'active_analysis_selections',
    'entities',
    'entity_aliases',
    'entity_alias_decisions',
    'entity_identity_events',
    'entity_identity_members',
    'observations',
    'artifacts',
    'artifact_chunks',
    'evidence',
    'analysis_evidence',
    'observation_evidence',
    'observation_entities',
    'correction_overlays',
    'spaces',
    'item_spaces',
    'review_state',
    'insights',
    'insight_observations',
    'organization_mutations',
    'change_log',
  ] as const;
  const before = new Map<string, unknown>();
  for (const table of preserved)
    before.set(
      table,
      (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
        .results,
    );
  const backup = new CoreBackup(env.DB, owner),
    start = await backup.begin(),
    chunks: BackupChunk[] = [];
  for (const table of backupTables) {
    let cursor: number | null = 0;
    do {
      const chunk = await backup.chunk(start.backup_id, table, cursor);
      chunks.push(chunk);
      cursor = chunk.next_cursor;
    } while (cursor !== null);
  }
  const portable = { manifest: await backup.complete(start.backup_id), chunks };
  await resetSchema();
  await expect(
    restoreCanonical(env.DB, portable, 'wrong-owner'),
  ).rejects.toThrow('RESTORE_OWNER_BINDING_REQUIRED');
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM owner_users').first('n'),
  ).toBe(0);
  expect(await restoreCanonical(env.DB, portable, 'subject-a')).toMatchObject({
    result: 'PASS',
    active_sessions_restored: 0,
    active_worker_credentials_restored: 0,
  });
  for (const table of preserved)
    expect(
      (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
        .results,
      table,
    ).toEqual(before.get(table));
  const restoredOwner = await fixtureOwner(),
    restoredIndex = new SearchIndex(env.DB, restoredOwner);
  expect((await restoredIndex.metadata()).freshness).toBe('UNKNOWN');
  for (let step = 0; step < 100; step++)
    if (!(await restoredIndex.step(fixtureNow)).progressed) break;
  expect(
    (
      await env.DB.prepare(
        'SELECT doc_id,parent_id,text,content_hash FROM search_documents ORDER BY doc_id',
      ).all()
    ).results,
  ).toEqual(searchBefore);
  expect(
    (await new LabQuotaPolicies(env.DB, restoredOwner).current())?.policy
      .daily_requests,
  ).toBe(0);
  expect(
    await new ArtifactRepository(env.DB, restoredOwner).readVerifiedText(
      artifact.artifact_id,
      1024,
    ),
  ).toMatchObject({
    text: sourceText,
    artifact: { content_hash: sourceHash, state: 'VERIFIED' },
  });
  expect(
    await env.DB.prepare(
      'SELECT state,fencing_token,lease_owner,lease_until FROM jobs WHERE job_id=?',
    )
      .bind(job.job_id)
      .first(),
  ).toEqual({
    state: 'RETRY_WAIT',
    fencing_token: lease.fencing_token + 1,
    lease_owner: null,
    lease_until: null,
  });
  await expect(AccessContext.worker(env.DB, workerHash)).rejects.toThrow(
    'UNAUTHENTICATED',
  );
  const restoredIdentity = new EntityIdentity(env.DB, restoredOwner);
  await restoredIdentity.confirm(
    await restoredIdentity.undoPreview(merge.event_id, 'Undo after restore'),
    fixtureNow,
  );
  expect(
    (await env.DB.prepare('SELECT * FROM entities ORDER BY rowid').all())
      .results,
  ).toEqual(before.get('entities'));
  expect(
    (await env.DB.prepare('PRAGMA foreign_key_check').all()).results,
  ).toEqual([]);
}, 30000);
