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
beforeEach(resetCore);
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
