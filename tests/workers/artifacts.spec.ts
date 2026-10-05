import { env } from 'cloudflare:workers';
import { beforeEach, it, expect } from 'vitest';
import { fixtureNow, fixtureOwner, resetCore } from './core-fixture.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import {
  ArtifactRepository,
  splitArtifactText,
  artifactChunkBytes,
} from '../../packages/core/src/artifacts/store.js';
import type { ArtifactDescriptor } from '../../packages/core/src/artifacts/store.js';
import {
  CoreBackup,
  backupTables,
} from '../../packages/core/src/backup/snapshot.js';
import type { BackupChunk } from '../../packages/core/src/backup/snapshot.js';
import { restoreCanonical } from '../../packages/core/src/backup/restore.js';
import { applyMigrations } from '../../packages/core/src/db/migrations.js';
import { RepresentationRepository } from '../../packages/core/src/transcript/representations.js';
import { selectTranscriptLanguage } from '../../packages/core/src/transcript/language.js';
import { TranscriptRecovery } from '../../packages/core/src/transcript/recovery.js';
import { sweep } from '../../packages/core/src/jobs/recovery.js';
import {
  QuotaAdmission,
  type AdmissionBucket,
} from '../../packages/core/src/ai/admission.js';
import type { TaskType } from '../../packages/contracts/src/jobs.js';
import { CandidateRepairAttempts } from '../../packages/core/src/ai/repair/attempts.js';
import { enrichEconomy } from '../../packages/core/src/ai/enrichment/canonical.js';
import { IntelligenceLedger } from '../../packages/core/src/ai/enrichment/ledger.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import { RunRepository } from '../../packages/core/src/jobs/acceptance.js';
beforeEach(resetCore);
it('canonical Ledger effects share the fenced acceptance batch, rollback on SQL failure and deduplicate redelivery', async () => {
  const { owner, access, token, item, repository } = await setup('ANALYZE');
  const text = 'I did not adopt Tool X.';
  const hash = await sha256(text);
  const artifact = await repository.begin(
    {
      item_id: item.item_id,
      kind: 'SOURCE_ORIGINAL',
      content_hash: hash,
      byte_size: new TextEncoder().encode(text).length,
      chunk_count: 1,
      schema_version: 'source-text:1',
      producer_version: 'fixture',
      provenance: { fixture: true },
      original_ref: null,
    },
    token,
    'ANALYZE',
    fixtureNow,
  );
  await repository.writeChunk(
    artifact.artifact_id,
    0,
    0,
    new TextEncoder().encode(text),
    token,
    'ANALYZE',
    fixtureNow,
  );
  await repository.verifyLocal(
    artifact.artifact_id,
    token,
    'ANALYZE',
    fixtureNow,
    'local',
  );
  const normalized = await normalizeTranscript(
    hash,
    [
      {
        upstream_index: 0,
        text,
        start_ms: 0,
        end_ms: 2000,
        speaker_label: null,
      },
    ],
    'CUE',
  );
  const mapText = JSON.stringify(normalized.manifest);
  const mapArtifact = await repository.begin(
    {
      item_id: item.item_id,
      kind: 'SEGMENT_MAP',
      content_hash: normalized.manifest_hash,
      byte_size: new TextEncoder().encode(mapText).length,
      chunk_count: 1,
      schema_version: 'segment-map:1',
      producer_version: 'source-normalizer:1',
      provenance: { fixture: true },
      original_ref: artifact.artifact_id,
    },
    token,
    'ANALYZE',
    fixtureNow,
  );
  await repository.writeChunk(
    mapArtifact.artifact_id,
    0,
    0,
    new TextEncoder().encode(mapText),
    token,
    'ANALYZE',
    fixtureNow,
  );
  await repository.verifyLocal(
    mapArtifact.artifact_id,
    token,
    'ANALYZE',
    fixtureNow,
    'local',
  );
  const ledger = new IntelligenceLedger(env.DB, access);
  const aliases = await ledger.aliases(token, fixtureNow);
  const claim = {
    text_pl: 'Autor nie wdrożył narzędzia.',
    segment_refs: ['s1'],
    subject_ref: null,
    entity_refs: [0],
    attribution: 'SOURCE_SPEAKER',
    qualifiers: ['negacja'],
  };
  const enriched = await enrichEconomy({
    raw: JSON.stringify({
      summary_pl: [{ text_pl: 'Próba narzędzia.', segment_refs: ['s1'] }],
      key_points: [],
      entity_mentions: [
        { label: 'Tool X', entity_type: 'TOOL', segment_refs: ['s1'] },
      ],
      tools: [],
      claims: [claim, claim],
      stance: [],
      predictions: [],
      source_issues: [],
    }),
    completion: 'OK',
    run_id: 'ledger-run',
    item_id: item.item_id,
    profile_id: 'ECONOMY',
    profile_revision: 'fixture',
    source: {
      owner_id: 'a',
      source_artifact_id: artifact.artifact_id,
      ...normalized,
      video_url: null,
    },
    approved_aliases: aliases,
  });
  const runs = new RunRepository(env.DB, access);
  await runs.prepare('ledger-run', token.job_id, fixtureNow.toISOString());
  const selection = await new RunRepository(env.DB, owner).requestSelection(
    'ledger-run',
    item.item_id,
  );
  const effects = await ledger.prepare(
    enriched,
    'ledger-run',
    token,
    fixtureNow,
  );
  await expect(
    runs.complete(
      { ...token, fencing_token: token.fencing_token + 1 },
      'ANALYZE',
      'ledger-run',
      enriched.canonical_hash,
      enriched.canonical,
      selection,
      fixtureNow,
      effects,
    ),
  ).rejects.toThrow('STALE_FENCE');
  expect(
    await env.DB.prepare('SELECT COUNT(*) FROM observations').first('COUNT(*)'),
  ).toBe(0);
  await expect(
    runs.complete(
      token,
      'ANALYZE',
      'ledger-run',
      enriched.canonical_hash,
      enriched.canonical,
      selection,
      fixtureNow,
      (guard, bindings) => [
        ...effects(guard, bindings),
        env.DB.prepare('INSERT INTO deliberately_missing_table VALUES(1)'),
      ],
    ),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare('SELECT COUNT(*) FROM observations').first('COUNT(*)'),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT state FROM analysis_runs WHERE run_id='ledger-run'",
    ).first('state'),
  ).toBe('CANDIDATE');
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) FROM outbox WHERE event_key='accepted:ledger-run'",
    ).first('COUNT(*)'),
  ).toBe(0);
  expect(
    await runs.complete(
      token,
      'ANALYZE',
      'ledger-run',
      enriched.canonical_hash,
      enriched.canonical,
      selection,
      fixtureNow,
      effects,
    ),
  ).toMatchObject({ accepted: true, active: true, duplicate: false });
  expect(
    await runs.complete(
      token,
      'ANALYZE',
      'ledger-run',
      enriched.canonical_hash,
      enriched.canonical,
      selection,
      fixtureNow,
      effects,
    ),
  ).toMatchObject({ accepted: true, duplicate: true });
  const rows = await new IntelligenceLedger(env.DB, owner).read('ledger-run');
  expect(rows).toHaveLength(1);
  expect(JSON.parse(String(rows[0]!.row_json))).toEqual(
    enriched.canonical.claims[0],
  );
  expect(rows[0]!.row_hash).toBe(
    await sha256(JSON.stringify(enriched.canonical.claims[0])),
  );
  expect(
    await new IntelligenceLedger(env.DB, await fixtureOwner('b')).read(
      'ledger-run',
    ),
  ).toEqual([]);
  expect(
    await env.DB.prepare('SELECT COUNT(*) FROM observation_evidence').first(
      'COUNT(*)',
    ),
  ).toBe(1);
  expect(
    await env.DB.prepare('SELECT COUNT(*) FROM observation_entities').first(
      'COUNT(*)',
    ),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) FROM outbox WHERE event_key='accepted:ledger-run'",
    ).first('COUNT(*)'),
  ).toBe(1);
  await expect(env.DB.prepare('DELETE FROM evidence').run()).rejects.toThrow(
    'IMMUTABLE_EVIDENCE',
  );
  await expect(
    env.DB.prepare('INSERT INTO observation_entities VALUES(?,?,?,?)')
      .bind(
        'b',
        enriched.observation_rows[0]!.observation_id,
        enriched.entity_resolutions[0]!.entity_id,
        'SUBJECT',
      )
      .run(),
  ).rejects.toThrow();
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
  const tables = (
    await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    ).all<{ name: string }>()
  ).results;
  await env.DB.batch([
    env.DB.prepare('PRAGMA defer_foreign_keys=ON'),
    ...tables.map((row) => env.DB.prepare(`DROP TABLE "${row.name}"`)),
  ]);
  await applyMigrations(env.DB, env.CORE_MIGRATIONS, fixtureNow.toISOString());
  await restoreCanonical(env.DB, portable, 'subject-a');
  const restoredOwner = await fixtureOwner();
  expect(
    await new IntelligenceLedger(env.DB, restoredOwner).read('ledger-run'),
  ).toEqual(rows);
  const evidenceRow = await env.DB.prepare(
    'SELECT source_hash,quote_hash,source_start,source_end FROM evidence WHERE owner_id=? AND evidence_id=?',
  )
    .bind('a', enriched.canonical.evidence[0]!.evidence_id)
    .first<{
      source_hash: string;
      quote_hash: string;
      source_start: number;
      source_end: number;
    }>();
  const restoredSource = await new ArtifactRepository(
    env.DB,
    restoredOwner,
  ).chunk(artifact.artifact_id, 0);
  const restoredText = new TextDecoder().decode(
    Uint8Array.from(
      atob(
        restoredSource.body_base64.replaceAll('-', '+').replaceAll('_', '/'),
      ),
      (char) => char.charCodeAt(0),
    ),
  );
  expect(await sha256(restoredText)).toBe(evidenceRow!.source_hash);
  expect(
    await sha256(
      restoredText.slice(evidenceRow!.source_start, evidenceRow!.source_end),
    ),
  ).toBe(evidenceRow!.quote_hash);
});
it('repair is admitted once per immutable candidate, never for unknown estimates or stale fences', async () => {
  const { owner, access, token, item, repository } = await setup('ANALYZE');
  const raw = '{"fixture":true,}';
  const artifact = await repository.begin(
    {
      item_id: item.item_id,
      kind: 'ANALYSIS_CANDIDATE',
      content_hash: await sha256(raw),
      byte_size: new TextEncoder().encode(raw).length,
      chunk_count: 1,
      schema_version: 'economy-wire:1.0',
      producer_version: 'fixture',
      provenance: {},
      original_ref: null,
    },
    token,
    'ANALYZE',
    fixtureNow,
  );
  await repository.writeChunk(
    artifact.artifact_id,
    0,
    0,
    new TextEncoder().encode(raw),
    token,
    'ANALYZE',
    fixtureNow,
  );
  await repository.verifyLocal(
    artifact.artifact_id,
    token,
    'ANALYZE',
    fixtureNow,
    'local',
  );
  const attempts = new CandidateRepairAttempts(env.DB, access);
  const input = {
    candidate_artifact_id: artifact.artifact_id,
    request_id: 'repair',
    estimated_repair_tokens: 35,
    estimated_full_retry_tokens: 100,
    error_class: 'FIXTURE_STRUCTURAL',
    measurement_hash: 'a'.repeat(64),
  };
  expect(
    await attempts.claim(
      { ...input, estimated_repair_tokens: null },
      token,
      fixtureNow,
    ),
  ).toBe(false);
  expect(
    await attempts.claim(
      { ...input, estimated_repair_tokens: 36 },
      token,
      fixtureNow,
    ),
  ).toBe(false);
  expect(
    await attempts.claim(
      input,
      { ...token, fencing_token: token.fencing_token + 1 },
      fixtureNow,
    ),
  ).toBe(false);
  const claims = await Promise.all([
    attempts.claim(input, token, fixtureNow),
    attempts.claim({ ...input, request_id: 'redelivery' }, token, fixtureNow),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(
    await attempts.claim({ ...input, request_id: 'third' }, token, fixtureNow),
  ).toBe(false);
  await expect(
    env.DB.prepare('DELETE FROM candidate_repair_attempts').run(),
  ).rejects.toThrow('IMMUTABLE_REPAIR_ATTEMPT');
  const backup = new CoreBackup(env.DB, owner);
  const start = await backup.begin();
  const chunks: BackupChunk[] = [];
  for (const table of backupTables) {
    let cursor: number | null = 0;
    do {
      const chunk = await backup.chunk(start.backup_id, table, cursor);
      chunks.push(chunk);
      cursor = chunk.next_cursor;
    } while (cursor !== null);
  }
  const portable = { manifest: await backup.complete(start.backup_id), chunks };
  const tables = (
    await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    ).all<{ name: string }>()
  ).results;
  await env.DB.batch([
    env.DB.prepare('PRAGMA defer_foreign_keys=ON'),
    ...tables.map((row) => env.DB.prepare(`DROP TABLE "${row.name}"`)),
  ]);
  await applyMigrations(env.DB, env.CORE_MIGRATIONS, fixtureNow.toISOString());
  await restoreCanonical(env.DB, portable, 'subject-a');
  expect(
    await env.DB.prepare(
      'SELECT COUNT(*) FROM candidate_repair_attempts WHERE candidate_artifact_id=?',
    )
      .bind(artifact.artifact_id)
      .first('COUNT(*)'),
  ).toBe(1);
  // Restore revokes the executor and fences the old attempt; it cannot consume another repair.
  expect(
    await attempts.claim(
      { ...input, request_id: 'after-restore' },
      token,
      new Date(),
    ),
  ).toBe(false);
});
it('caption recovery persists independent counters and derives a durable shared circuit', async () => {
  const { access, token } = await setup(),
    recovery = new TranscriptRecovery(env.DB, access);
  const first = await recovery.outcome(token, 'NO_CAPTIONS', fixtureNow);
  expect(Date.parse(first.due_at) - fixtureNow.getTime()).toBe(3600000);
  await expect(
    recovery.outcome(token, 'NO_CAPTIONS', fixtureNow),
  ).rejects.toThrow('STALE_FENCE');
  const next = new Date(Date.parse(first.due_at));
  await sweep(env.DB, next, () => true);
  const store = new JobStore(env.DB, access),
    token2 = (await store.lease(
      token.job_id,
      'FETCH_TRANSCRIPT',
      next,
      'local',
    ))!;
  await store.start(token2, 'FETCH_TRANSCRIPT', next);
  const second = await recovery.outcome(token2, 'NO_CAPTIONS', next);
  expect(Date.parse(second.due_at) - next.getTime()).toBe(21600000);
  await env.DB.prepare(
    'INSERT INTO job_attempts(attempt_id,owner_id,job_id,fencing_token,executor_id,started_at,finished_at,error_code) VALUES(?,?,?,?,?,?,?,?)',
  )
    .bind(
      'parser',
      'a',
      token.job_id,
      999,
      'artifact-worker',
      fixtureNow.toISOString(),
      fixtureNow.toISOString(),
      'LOCAL_YTDLP_PARSER_CHANGED',
    )
    .run();
  await env.DB.prepare(
    'INSERT INTO job_attempts(attempt_id,owner_id,job_id,fencing_token,executor_id,started_at,finished_at,error_code) VALUES(?,?,?,?,?,?,?,?)',
  )
    .bind(
      'ip',
      'a',
      token.job_id,
      1000,
      'artifact-worker',
      next.toISOString(),
      next.toISOString(),
      'LOCAL_YTDLP_IP_BLOCKED',
    )
    .run();
  const later = new Date(next.getTime() + 3600000);
  expect((await recovery.admission(later, 'local')).reason).toBe(
    'LOCAL_YTDLP_PARSER_CHANGED',
  );
  expect(
    (
      await recovery.admission(
        new Date(fixtureNow.getTime() + 21600000),
        'local',
      )
    ).available,
  ).toBe(true);
  expect((await recovery.admission(later, 'cloud')).reason).toBe(
    'LOCAL_EXECUTOR_REQUIRED',
  );
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM job_attempts WHERE error_code='LOCAL_YTDLP_NO_CAPTIONS'",
    ).first('n'),
  ).toBe(2);
});
async function setup(taskType: TaskType = 'FETCH_TRANSCRIPT') {
  const owner = await fixtureOwner(),
    source = (await new SourceRepository(env.DB, owner).upsert(
      {
        namespace: 'youtube',
        external_id: 'UC-fixture',
        canonical_locator: 'https://www.youtube.com/channel/fixture',
        title: 'Fixture',
        uploads_playlist_id: 'UU-fixture',
        handle: null,
      },
      fixtureNow.toISOString(),
    ))!;
  const item = (await new ItemRepository(env.DB, owner).upsert(
    source.source_id,
    {
      namespace: 'youtube',
      external_id: 'artifact001',
      canonical_url: 'https://www.youtube.com/watch?v=artifact001',
      title: 'Fixture',
      item_type: 'video',
      published_at: null,
      publication_provenance: 'unknown',
      availability: 'PUBLIC',
      duration_seconds: 60,
    },
    fixtureNow.toISOString(),
  ))!;
  const credential = await sha256('artifact-worker-fixture');
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'artifact-worker',
      'a',
      credential,
      JSON.stringify([taskType]),
      fixtureNow.toISOString(),
    )
    .run();
  const job = (await new JobStore(env.DB, owner).enqueue(
    {
      item_id: item.item_id,
      source_id: source.source_id,
      task_type: taskType,
      input_revision: 'fixture',
      profile_revision: 'fixture',
      prompt_snapshot_id: null,
      routing_policy_version: 'local-1',
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: fixtureNow.toISOString(),
      origin_kind: 'NEW',
      payload: {},
      priority: 80,
      due_at: fixtureNow.toISOString(),
    },
    fixtureNow.toISOString(),
  ))!;
  const access = await AccessContext.worker(env.DB, credential),
    store = new JobStore(env.DB, access),
    token = (await store.lease(job.job_id, taskType, fixtureNow, 'local'))!;
  await store.start(token, taskType, fixtureNow);
  return {
    owner,
    access,
    item,
    token,
    repository: new ArtifactRepository(env.DB, access),
  };
}
it('atomic AI reservation has one winner for the last request and cannot resubmit or use stale lease', async () => {
  const { access, token } = await setup('ANALYZE'),
    quota = new QuotaAdmission(env.DB, access);
  const buckets: AdmissionBucket[] = [];
  for (const bucket of ['RPM', 'RPD', 'INPUT_TPM'] as const) {
    const row = {
      snapshot_id: bucket,
      bucket,
      window_start: fixtureNow.toISOString(),
      reset_at: new Date(fixtureNow.getTime() + 3600000).toISOString(),
      remaining: bucket === 'INPUT_TPM' ? 1000 : 1,
      sampled_at: fixtureNow.toISOString(),
      expires_at: new Date(fixtureNow.getTime() + 60000).toISOString(),
      reserve: 0,
    };
    buckets.push(row);
    await env.DB.prepare(
      'INSERT INTO quota_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
      .bind(
        bucket,
        'a',
        'gemini',
        'gemini-3.8-flash',
        bucket,
        bucket === 'INPUT_TPM' ? 'tokens' : 'requests',
        row.remaining,
        0,
        row.remaining,
        row.reset_at,
        'America/Los_Angeles',
        'dashboard',
        row.sampled_at,
        row.expires_at,
        'actual',
      )
      .run();
  }
  const input = {
    account_key: 'fixture-project',
    model: 'gemini-3.8-flash',
    input_tokens: 100,
    buckets,
    paid_services_enabled: false,
  };
  const results = await Promise.allSettled(
    ['first', 'second'].map((request_id) =>
      quota.reserve({ ...input, request_id }, token, fixtureNow),
    ),
  );
  expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS n FROM quota_reservations').first(
      'n',
    ),
  ).toBe(1);
  const winner = results.find((row) => row.status === 'fulfilled')!;
  if (winner.status !== 'fulfilled') throw new Error('FIXTURE');
  await quota.submit(winner.value.reservation_id, token, fixtureNow);
  await expect(
    quota.submit(winner.value.reservation_id, token, fixtureNow),
  ).rejects.toThrow('RESERVATION_NOT_SUBMITTABLE');
  await expect(
    quota.reserve(
      { ...input, request_id: 'stale' },
      { ...token, fencing_token: token.fencing_token + 1 },
      fixtureNow,
    ),
  ).rejects.toThrow('QUOTA_ADMISSION_DENIED');
  await expect(
    quota.reserve(
      { ...input, request_id: 'paid', paid_services_enabled: true },
      token,
      fixtureNow,
    ),
  ).rejects.toThrow('PAID_SERVICES_DISABLED_REQUIRED');
  const response = {
    request_id: winner.value.request_id,
    status: 'TEMPORARY_FAILURE' as const,
    raw_output: null,
    actual_provider: 'gemini',
    actual_model: null,
    finish_reason: 'TRANSPORT_FAILURE',
    usage: { input_tokens: null, output_tokens: null, total_tokens: null },
    retry_after: null,
  };
  await quota.reconcile(winner.value.reservation_id, response, fixtureNow);
  await quota.reconcile(winner.value.reservation_id, response, fixtureNow);
  expect(
    await env.DB.prepare(
      'SELECT state FROM quota_reservations WHERE reservation_id=?',
    )
      .bind(winner.value.reservation_id)
      .first('state'),
  ).toBe('UNKNOWN');
  expect(
    await env.DB.prepare(
      'SELECT charged_input_tokens FROM quota_reservations WHERE reservation_id=?',
    )
      .bind(winner.value.reservation_id)
      .first('charged_input_tokens'),
  ).toBe(100);
  await expect(
    quota.reserve({ ...input, request_id: 'after-timeout' }, token, fixtureNow),
  ).rejects.toThrow('QUOTA_ADMISSION_DENIED');
  await expect(
    quota.reconcile(
      winner.value.reservation_id,
      {
        ...response,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
      fixtureNow,
    ),
  ).rejects.toThrow('USAGE_RECONCILIATION_CONFLICT');
});
it('representation binds verified source, immutable selection and current fence', async () => {
  const { access, item, token, repository } = await setup();
  const text = 'Original source',
    bytes = new TextEncoder().encode(text),
    hash = await sha256(text);
  const selection = selectTranscriptLanguage(
    {
      status: 'OK',
      failure_code: null,
      provider_id: 'fixture',
      provider_version: 'fixture-1',
      runtime_id: 'local',
      video_language: 'en',
      retrieved_at: fixtureNow.toISOString(),
      request_id: 'fixture',
      tracks: [
        {
          track_id: 'track',
          item_id: item.item_id,
          language_code: 'en',
          track_kind: 'MANUAL',
          is_generated: false,
          is_translated: false,
          source_language: null,
          translation_source_track_id: null,
          is_translatable: null,
          translation_languages: [],
          is_original: null,
          extension: 'json3',
          expires_at: fixtureNow.toISOString(),
        },
      ],
    },
    hash,
  );
  const artifact = await repository.begin(
    {
      item_id: item.item_id,
      kind: 'SOURCE_ORIGINAL',
      content_hash: hash,
      byte_size: bytes.length,
      chunk_count: 1,
      schema_version: 'source-1',
      producer_version: 'fixture-1',
      provenance: { provider_id: 'fixture', upstream_track_id: 'track' },
      original_ref: null,
    },
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
  );
  const representations = new RepresentationRepository(env.DB, access);
  await expect(
    representations.record(
      artifact.artifact_id,
      selection,
      'SOURCE_AUTHORITY',
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).rejects.toThrow('INVALID_REPRESENTATION_SOURCE');
  await repository.writeChunk(
    artifact.artifact_id,
    0,
    0,
    bytes,
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
  );
  await repository.verifyLocal(
    artifact.artifact_id,
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
    'local',
  );
  const id = await representations.record(
    artifact.artifact_id,
    selection,
    'SOURCE_AUTHORITY',
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
  );
  expect(
    await representations.record(
      artifact.artifact_id,
      selection,
      'SOURCE_AUTHORITY',
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).toBe(id);
  expect(
    await representations.record(
      artifact.artifact_id,
      {
        ...selection,
        source: {
          ...selection.source!,
          expires_at: new Date(fixtureNow.getTime() + 600000).toISOString(),
        },
      },
      'SOURCE_AUTHORITY',
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).toBe(id);
  await expect(
    representations.record(
      artifact.artifact_id,
      { ...selection, source_revision: 'b'.repeat(64) },
      'SOURCE_AUTHORITY',
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).rejects.toThrow('REPRESENTATION_REVISION_MISMATCH');
  await expect(
    representations.record(
      artifact.artifact_id,
      { ...selection, authority_basis: 'EXPLICIT_ORIGINAL' },
      'SOURCE_AUTHORITY',
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).rejects.toThrow('REPRESENTATION_CONFLICT');
  await expect(
    representations.record(
      artifact.artifact_id,
      selection,
      'SOURCE_AUTHORITY',
      { ...token, fencing_token: token.fencing_token + 1 },
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM transcript_representations',
    ).first('n'),
  ).toBe(1);
});
it('large Unicode cue is resumable, ordered/hash verified, immutable and portable through canonical restore', async () => {
  const { owner, item, token, repository } = await setup(),
    text = 'e\u0301🦋\n'.repeat(13000),
    chunks = splitArtifactText(text);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(chunk.byteLength).toBeLessThanOrEqual(artifactChunkBytes);
    expect(() =>
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(chunk),
    ).not.toThrow();
  }
  const descriptor: ArtifactDescriptor = {
    item_id: item.item_id,
    kind: 'SOURCE_ORIGINAL',
    content_hash: await sha256(text),
    byte_size: new TextEncoder().encode(text).byteLength,
    chunk_count: chunks.length,
    schema_version: 'source-text-1',
    producer_version: 'fixture-1',
    provenance: { provider: 'fixture', language: 'unknown' },
    original_ref: null,
  };
  const artifact = await repository.begin(
    descriptor,
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
  );
  await expect(
    repository.verifyLocal(
      artifact.artifact_id,
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
      'local',
    ),
  ).rejects.toThrow('ARTIFACT_CHUNK_MISSING');
  expect(
    (
      await repository.get(
        artifact.artifact_id,
        token,
        'FETCH_TRANSCRIPT',
        fixtureNow,
      )
    ).state,
  ).toBe('UPLOADING');
  let offset = 0;
  for (let index = 0; index < chunks.length; index++) {
    await repository.writeChunk(
      artifact.artifact_id,
      index,
      offset,
      chunks[index]!,
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    );
    offset += chunks[index]!.length;
  }
  expect(
    (await repository.begin(descriptor, token, 'FETCH_TRANSCRIPT', fixtureNow))
      .artifact_id,
  ).toBe(artifact.artifact_id);
  await expect(
    repository.writeChunk(
      artifact.artifact_id,
      0,
      0,
      new TextEncoder().encode('changed'),
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).rejects.toThrow('ARTIFACT_CHUNK_CONFLICT');
  const verified = await repository.verifyLocal(
    artifact.artifact_id,
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
    'local',
  );
  expect(verified.state).toBe('VERIFIED');
  expect(verified.manifest_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (
      await repository.verifyLocal(
        artifact.artifact_id,
        token,
        'FETCH_TRANSCRIPT',
        fixtureNow,
        'local',
      )
    ).manifest_hash,
  ).toBe(verified.manifest_hash);
  await expect(
    env.DB.prepare('UPDATE artifacts SET content_hash=? WHERE artifact_id=?')
      .bind('0'.repeat(64), artifact.artifact_id)
      .run(),
  ).rejects.toThrow('IMMUTABLE_ARTIFACT');
  await expect(
    new ArtifactRepository(env.DB, await fixtureOwner('b')).get(
      artifact.artifact_id,
    ),
  ).rejects.toThrow('NOT_FOUND');
  await expect(
    repository.get(
      artifact.artifact_id,
      { ...token, fencing_token: 0 },
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).rejects.toThrow('NOT_FOUND');
  const backup = new CoreBackup(env.DB, owner),
    start = await backup.begin(),
    portableChunks: BackupChunk[] = [];
  for (const table of backupTables) {
    let cursor: number | null = 0;
    do {
      const chunk = await backup.chunk(start.backup_id, table, cursor);
      portableChunks.push(chunk);
      cursor = chunk.next_cursor;
    } while (cursor !== null);
  }
  const portable = {
    manifest: await backup.complete(start.backup_id),
    chunks: portableChunks,
  };
  const tables = (
    await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    ).all<{ name: string }>()
  ).results;
  await env.DB.batch([
    env.DB.prepare('PRAGMA defer_foreign_keys=ON'),
    ...tables.map((row) => env.DB.prepare(`DROP TABLE "${row.name}"`)),
  ]);
  await applyMigrations(env.DB, env.CORE_MIGRATIONS, fixtureNow.toISOString());
  await restoreCanonical(env.DB, portable, 'subject-a');
  const restored = new ArtifactRepository(env.DB, await fixtureOwner());
  expect((await restored.get(artifact.artifact_id)).manifest_hash).toBe(
    verified.manifest_hash,
  );
  let restoredText = '';
  for (let index = 0; index < chunks.length; index++) {
    const row = await restored.chunk(artifact.artifact_id, index);
    restoredText += new TextDecoder().decode(
      Uint8Array.from(
        atob(row.body_base64.replaceAll('-', '+').replaceAll('_', '/')),
        (char) => char.charCodeAt(0),
      ),
    );
  }
  expect(restoredText).toBe(text);
  expect(await sha256(restoredText)).toBe(descriptor.content_hash);
  // Inject physical corruption only in the disposable fixture, bypassing its immutability trigger.
  await env.DB.prepare('DROP TRIGGER artifact_chunks_no_update').run();
  await env.DB.prepare(
    "UPDATE artifact_chunks SET body_base64='YQ' WHERE chunk_index=0",
  ).run();
  await expect(restored.chunk(artifact.artifact_id, 0)).rejects.toThrow(
    'ARTIFACT_CHUNK_CORRUPT',
  );
});
it('empty payload is valid but oversized chunk, bad range, wrong total hash and unverified parent cannot become VERIFIED', async () => {
  const { item, token, repository } = await setup();
  const descriptor: ArtifactDescriptor = {
    item_id: item.item_id,
    kind: 'RAW',
    content_hash: await sha256(''),
    byte_size: 0,
    chunk_count: 1,
    schema_version: 'raw-1',
    producer_version: 'fixture-1',
    provenance: {},
    original_ref: null,
  };
  const empty = await repository.begin(
    descriptor,
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
  );
  await expect(
    repository.begin(
      { ...descriptor, kind: 'NORMALIZED', original_ref: empty.artifact_id },
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).rejects.toThrow('ARTIFACT_PARENT_NOT_VERIFIED');
  await expect(
    repository.writeChunk(
      empty.artifact_id,
      0,
      0,
      new Uint8Array(artifactChunkBytes + 1),
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
    ),
  ).rejects.toThrow('INVALID_ARTIFACT_CHUNK');
  await repository.writeChunk(
    empty.artifact_id,
    0,
    0,
    new Uint8Array(),
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
  );
  let clockReads = 0;
  await expect(
    repository.verifyLocal(
      empty.artifact_id,
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
      'local',
      () =>
        new Date(fixtureNow.getTime() + (clockReads++ === 0 ? 0 : 16 * 60000)),
    ),
  ).rejects.toThrow('NOT_FOUND');
  expect(
    (
      await repository.get(
        empty.artifact_id,
        token,
        'FETCH_TRANSCRIPT',
        fixtureNow,
      )
    ).state,
  ).toBe('UPLOADING');
  expect(
    (
      await repository.verifyLocal(
        empty.artifact_id,
        token,
        'FETCH_TRANSCRIPT',
        fixtureNow,
        'local',
      )
    ).state,
  ).toBe('VERIFIED');
  const bad = await repository.begin(
    { ...descriptor, byte_size: 1, content_hash: '0'.repeat(64) },
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
  );
  await repository.writeChunk(
    bad.artifact_id,
    0,
    0,
    new Uint8Array([97]),
    token,
    'FETCH_TRANSCRIPT',
    fixtureNow,
  );
  await expect(
    repository.verifyLocal(
      bad.artifact_id,
      token,
      'FETCH_TRANSCRIPT',
      fixtureNow,
      'local',
    ),
  ).rejects.toThrow('ARTIFACT_CONTENT_MISMATCH');
});
