import { controlTick } from '../control.js';
import { AnalysisJobs } from '../../../../packages/core/src/ai/jobs.js';
import {
  OptionalAIJobs,
  type OptionalTask,
} from '../../../../packages/core/src/ai/tasks/jobs.js';
import { sha256 } from '../../../../packages/core/src/auth/crypto.js';
import { AnalysisDisposition } from '../../../../packages/core/src/ai/disposition.js';
import type { compileEconomy } from '../../../../packages/core/src/ai/compiler.js';
import { AnalysisResponses } from '../../../../packages/core/src/ai/responses.js';
import { AnalysisValidation } from '../../../../packages/core/src/ai/validation.js';
import { LongInputJobs } from '../../../../packages/core/src/ai/long-input/jobs.js';
import { LongInputCompletion } from '../../../../packages/core/src/ai/long-input/completion.js';
import { apiRouter, body, text, queryFields } from './common.js';
import { CapacityCollection } from '../../../../packages/core/src/projections/capacity-collection.js';
import { SearchIndex } from '../../../../packages/core/src/knowledge/search-index.js';
import { taskTypes } from '../../../../packages/contracts/src/jobs.js';
import type {
  LeaseToken,
  TaskType,
} from '../../../../packages/contracts/src/jobs.js';
import { JobStore } from '../../../../packages/core/src/jobs/store.js';
import { pull } from '../../../../packages/core/src/jobs/recovery.js';
import { retryDisposition } from '../../../../packages/core/src/jobs/policy.js';
import { executeDiscoveryChunk } from '../../../../packages/core/src/sources/youtube/executor.js';
import { YoutubeClient } from '../../../../packages/core/src/sources/youtube/client.js';
import { TranscriptRecovery } from '../../../../packages/core/src/transcript/recovery.js';
import { transcriptStatuses } from '../../../../packages/contracts/src/transcript.js';
import {
  ArtifactRepository,
  type ArtifactDescriptor,
} from '../../../../packages/core/src/artifacts/store.js';
import { decode64 } from '../../../../packages/core/src/auth/crypto.js';
import {
  TranscriptAcceptance,
  type TranscriptSourceCompletion,
} from '../../../../packages/core/src/transcript/acceptance.js';
export const workersApp = apiRouter();
workersApp.use('*', async (c, next) => {
  // Authenticate before reading payload or any domain row. Scope is checked again per action.
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
    c.req.header('Authorization') ?? '',
  );
  if (!match) throw new Error('UNAUTHENTICATED');
  const { AccessContext } =
    await import('../../../../packages/core/src/db/boundary.js');
  const { sha256 } =
    await import('../../../../packages/core/src/auth/crypto.js');
  c.set(
    'access',
    await AccessContext.worker(c.env.DB, await sha256(match[1]!)),
  );
  await next();
});
function task(value: unknown): TaskType {
  if (!taskTypes.some((entry) => entry === value))
    throw new Error('INVALID_TASK');
  return value as TaskType;
}
function optionalTask(value: unknown): OptionalTask {
  if (value !== 'TRANSLATE' && value !== 'HISTORICAL_COMPARE')
    throw new Error('INVALID_TASK');
  return value;
}
workersApp.post('/analysis/schedule', async (c) => {
  const input = await body(c, ['after']);
  let after: { accepted_at: string; run_id: string } | null = null;
  if (input.after !== undefined && input.after !== null) {
    if (
      typeof input.after !== 'object' ||
      Array.isArray(input.after) ||
      Object.keys(input.after).some(
        (key) => !['accepted_at', 'run_id'].includes(key),
      )
    )
      throw new Error('INVALID_AUTOMATIC_CURSOR');
    const cursor = input.after as Record<string, unknown>;
    after = {
      accepted_at: text(cursor.accepted_at, 32),
      run_id: text(cursor.run_id, 128),
    };
  }
  return c.json(
    await new AnalysisJobs(c.env.DB, c.get('access')).scheduleAutomatic(
      new Date(),
      after,
    ),
  );
});
workersApp.post('/optional/input', async (c) => {
  const input = await body(c, ['token', 'task_type']),
    access = c.get('access');
  return c.json(
    await new OptionalAIJobs(c.env.DB, access).prepare(
      token(input.token, access.actorId),
      optionalTask(input.task_type),
      new Date(),
    ),
  );
});
workersApp.post('/optional/reserve', async (c) => {
  const input = await body(c, [
      'token',
      'task_type',
      'request_id',
      'input_tokens',
    ]),
    access = c.get('access'),
    jobs = new OptionalAIJobs(c.env.DB, access),
    lease = token(input.token, access.actorId),
    task = optionalTask(input.task_type),
    now = new Date();
  const prepared = await jobs.prepare(lease, task, now);
  if (
    input.request_id !== prepared.run_id ||
    input.input_tokens !== prepared.request.estimated_input_tokens
  )
    throw new Error('INVALID_AI_REQUEST_SCOPE');
  return c.json(await jobs.reserve(lease, task, now));
});
workersApp.post('/optional/submit', async (c) => {
  const input = await body(c, [
      'token',
      'task_type',
      'reservation_id',
      'request_prompt_hash',
    ]),
    access = c.get('access'),
    jobs = new OptionalAIJobs(c.env.DB, access),
    lease = token(input.token, access.actorId),
    task = optionalTask(input.task_type),
    now = new Date();
  if (
    input.request_prompt_hash !==
    (await sha256((await jobs.prepare(lease, task, now)).request.prompt))
  )
    throw new Error('INVALID_AI_REQUEST_SCOPE');
  return c.json(
    await jobs.submit(lease, task, text(input.reservation_id, 36), now),
  );
});
workersApp.post('/optional/response', async (c) => {
  const input = await body(c, [
      'token',
      'task_type',
      'reservation_id',
      'artifact_id',
    ]),
    access = c.get('access');
  return c.json(
    await new AnalysisResponses(
      c.env.DB,
      access,
      optionalTask(input.task_type),
    ).record(
      token(input.token, access.actorId),
      text(input.reservation_id, 36),
      text(input.artifact_id, 128),
      new Date(),
    ),
  );
});
workersApp.post('/optional/complete', async (c) => {
  const input = await body(c, [
      'token',
      'task_type',
      'reservation_id',
      'artifact_id',
    ]),
    access = c.get('access');
  if (!c.env.SESSION_SIGNING_SECRET)
    throw new Error('AUTH_CONFIGURATION_REQUIRED');
  return c.json(
    await new OptionalAIJobs(c.env.DB, access).complete(
      token(input.token, access.actorId),
      optionalTask(input.task_type),
      text(input.reservation_id, 36),
      text(input.artifact_id, 128),
      new Date(),
      c.env.SESSION_SIGNING_SECRET,
    ),
  );
});
workersApp.post('/search/step', async (c) => {
  await body(c, []);
  return c.json(
    await new SearchIndex(c.env.DB, c.get('access')).step(new Date()),
  );
});
workersApp.get('/capacity-observation', async (c) => {
  queryFields(c, ['limit', 'cursor']);
  return c.json(
    await new CapacityCollection(c.env.DB, c.get('access')).page(
      Number(c.req.query('limit') ?? 50),
      c.env.SESSION_SIGNING_SECRET!,
      new Date(),
      c.req.query('cursor'),
    ),
  );
});
function runtime(value: unknown) {
  if (value !== 'local' && value !== 'cloud')
    throw new Error('INVALID_RUNTIME');
  return value;
}
function token(value: unknown, actor: string): LeaseToken {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_LEASE');
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (key) =>
        !['job_id', 'lease_owner', 'fencing_token', 'lease_until'].includes(
          key,
        ),
    ) ||
    row.lease_owner !== actor ||
    !Number.isSafeInteger(row.fencing_token) ||
    Number(row.fencing_token) < 1 ||
    typeof row.lease_until !== 'string' ||
    !Number.isFinite(Date.parse(row.lease_until))
  )
    throw new Error('INVALID_LEASE');
  return {
    job_id: text(row.job_id, 128),
    lease_owner: actor,
    fencing_token: Number(row.fencing_token),
    lease_until: row.lease_until,
  };
}
function artifactTask(value: unknown) {
  const type = task(value);
  if (
    ![
      'FETCH_TRANSCRIPT',
      'NORMALIZE',
      'ANALYZE',
      'TRANSLATE',
      'REPROCESS',
    ].includes(type)
  )
    throw new Error('INVALID_ARTIFACT_TASK');
  return type;
}
workersApp.post('/source-correction/input', async (c) => {
  const input = await body(c, ['token']),
    access = c.get('access');
  const { SourceCorrectionJobs } =
    await import('../../../../packages/core/src/transcript/correction-jobs.js');
  return c.json(
    await new SourceCorrectionJobs(c.env.DB, access).input(
      token(input.token, access.actorId),
      new Date(),
    ),
  );
});
workersApp.post('/source-correction/complete', async (c) => {
  const input = await body(c, [
      'token',
      'source_artifact_id',
      'segment_map_artifact_id',
    ]),
    access = c.get('access');
  const { SourceCorrectionJobs } =
    await import('../../../../packages/core/src/transcript/correction-jobs.js');
  return c.json(
    await new SourceCorrectionJobs(c.env.DB, access).complete(
      token(input.token, access.actorId),
      text(input.source_artifact_id, 128),
      text(input.segment_map_artifact_id, 128),
      new Date(),
    ),
  );
});
workersApp.post('/analysis/input', async (c) => {
  const input = await body(c, ['token']);
  const access = c.get('access');
  const prepared = await new AnalysisJobs(c.env.DB, access).prepareRun(
    token(input.token, access.actorId),
    new Date(),
  );
  const serialized = JSON.stringify(prepared);
  if (new TextEncoder().encode(serialized).length > 65536)
    throw new Error('ANALYSIS_SNAPSHOT_TOO_LARGE');
  return c.body(serialized, 200, { 'Content-Type': 'application/json' });
});
workersApp.post('/analysis/context', async (c) => {
  const input = await body(c, [
      'token',
      'context',
      'context_hash',
      'request_prompt_hash',
    ]),
    access = c.get('access');
  return c.json(
    await new AnalysisJobs(c.env.DB, access).bindContext(
      token(input.token, access.actorId),
      input.context as Awaited<
        ReturnType<typeof compileEconomy>
      >['run_context'],
      text(input.context_hash, 64),
      text(input.request_prompt_hash, 64),
      new Date(),
    ),
  );
});
workersApp.post('/analysis/reserve', async (c) => {
  const input = await body(c, ['token', 'request_id', 'input_tokens']);
  const access = c.get('access');
  return c.json(
    await new AnalysisJobs(c.env.DB, access).reserve(
      token(input.token, access.actorId),
      {
        request_id: text(input.request_id, 128),
        input_tokens: input.input_tokens as number,
      },
      new Date(),
    ),
  );
});
workersApp.post('/analysis/submit', async (c) => {
  const input = await body(c, [
    'token',
    'reservation_id',
    'request_prompt_hash',
  ]);
  const access = c.get('access'),
    lease = token(input.token, access.actorId),
    now = new Date();
  return c.json(
    await new AnalysisJobs(c.env.DB, access).submit(
      lease,
      text(input.reservation_id, 128),
      text(input.request_prompt_hash, 64),
      now,
    ),
  );
});
workersApp.post('/analysis/response', async (c) => {
  const input = await body(c, ['token', 'reservation_id', 'artifact_id']);
  const access = c.get('access');
  return c.json(
    await new AnalysisResponses(c.env.DB, access).record(
      token(input.token, access.actorId),
      text(input.reservation_id, 36),
      text(input.artifact_id, 128),
      new Date(),
    ),
  );
});
workersApp.post('/analysis/validate', async (c) => {
  const input = await body(c, ['token', 'reservation_id', 'artifact_id']),
    access = c.get('access');
  if (!c.env.SESSION_SIGNING_SECRET)
    throw new Error('AUTH_CONFIGURATION_REQUIRED');
  return c.json(
    await new AnalysisValidation(c.env.DB, access).evaluate(
      token(input.token, access.actorId),
      text(input.reservation_id, 36),
      text(input.artifact_id, 128),
      new Date(),
      c.env.SESSION_SIGNING_SECRET,
    ),
  );
});
workersApp.post('/analysis/complete', async (c) => {
  const input = await body(c, ['token', 'reservation_id', 'artifact_id']),
    access = c.get('access');
  if (!c.env.SESSION_SIGNING_SECRET)
    throw new Error('AUTH_CONFIGURATION_REQUIRED');
  return c.json(
    await new AnalysisValidation(c.env.DB, access).complete(
      token(input.token, access.actorId),
      text(input.reservation_id, 36),
      text(input.artifact_id, 128),
      new Date(),
      c.env.SESSION_SIGNING_SECRET,
    ),
  );
});
workersApp.post('/analysis/quality-finish', async (c) => {
  const input = await body(c, ['token', 'reservation_id', 'artifact_id']),
    access = c.get('access');
  if (!c.env.SESSION_SIGNING_SECRET)
    throw new Error('AUTH_CONFIGURATION_REQUIRED');
  return c.json(
    await new AnalysisValidation(c.env.DB, access).finishQualityTest(
      token(input.token, access.actorId),
      text(input.reservation_id, 36),
      text(input.artifact_id, 128),
      new Date(),
      c.env.SESSION_SIGNING_SECRET,
    ),
  );
});
workersApp.post('/analysis/chunks/create', async (c) => {
  const input = await body(c, ['token', 'plan_artifact_id']),
    access = c.get('access');
  return c.json(
    await new LongInputJobs(c.env.DB, access).create(
      token(input.token, access.actorId),
      text(input.plan_artifact_id, 128),
      new Date(),
    ),
  );
});
workersApp.post('/analysis/chunks/status', async (c) => {
  const input = await body(c, ['parent_job_id']),
    access = c.get('access');
  return c.json(
    await new LongInputJobs(c.env.DB, access).status(
      text(input.parent_job_id, 128),
    ),
  );
});
workersApp.post('/analysis/chunks/complete', async (c) => {
  const input = await body(c, ['token']),
    access = c.get('access');
  if (!c.env.SESSION_SIGNING_SECRET)
    throw new Error('AUTH_CONFIGURATION_REQUIRED');
  return c.json(
    await new LongInputCompletion(c.env.DB, access).complete(
      token(input.token, access.actorId),
      new Date(),
      c.env.SESSION_SIGNING_SECRET,
    ),
  );
});
workersApp.post('/analysis/chunk-finish', async (c) => {
  const input = await body(c, ['token', 'reservation_id', 'artifact_id']),
    access = c.get('access');
  if (!c.env.SESSION_SIGNING_SECRET)
    throw new Error('AUTH_CONFIGURATION_REQUIRED');
  return c.json(
    await new AnalysisValidation(c.env.DB, access).finishChunk(
      token(input.token, access.actorId),
      text(input.reservation_id, 36),
      text(input.artifact_id, 128),
      new Date(),
      c.env.SESSION_SIGNING_SECRET,
    ),
  );
});
workersApp.post('/analysis/disposition', async (c) => {
  const input = await body(c, ['token', 'reservation_id', 'artifact_id']),
    access = c.get('access');
  if (!c.env.SESSION_SIGNING_SECRET)
    throw new Error('AUTH_CONFIGURATION_REQUIRED');
  return c.json(
    await new AnalysisDisposition(c.env.DB, access).apply(
      token(input.token, access.actorId),
      text(input.reservation_id, 36),
      text(input.artifact_id, 128),
      new Date(),
      c.env.SESSION_SIGNING_SECRET,
    ),
  );
});
function diagnosticReservation(input: Record<string, unknown>) {
  return input.reservation_id === undefined
    ? null
    : text(input.reservation_id, 36);
}
workersApp.post('/artifacts/begin', async (c) => {
  const input = await body(c, [
      'task_type',
      'token',
      'descriptor',
      'reservation_id',
    ]),
    access = c.get('access');
  const value = input.descriptor;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_ARTIFACT_DESCRIPTOR');
  const d = value as Record<string, unknown>;
  if (
    Object.keys(d).some(
      (key) =>
        ![
          'item_id',
          'kind',
          'content_hash',
          'byte_size',
          'chunk_count',
          'schema_version',
          'producer_version',
          'provenance',
          'original_ref',
        ].includes(key),
    ) ||
    ![
      'RAW',
      'SOURCE_ORIGINAL',
      'NORMALIZED',
      'PL_HELPER',
      'ANALYSIS_CANDIDATE',
      'SEGMENT_MAP',
      'OFFSET_MAP',
    ].includes(String(d.kind)) ||
    !Number.isSafeInteger(d.byte_size) ||
    !Number.isSafeInteger(d.chunk_count) ||
    !d.provenance ||
    typeof d.provenance !== 'object' ||
    Array.isArray(d.provenance) ||
    !(d.original_ref === null || typeof d.original_ref === 'string')
  )
    throw new Error('INVALID_ARTIFACT_DESCRIPTOR');
  const descriptor: ArtifactDescriptor = {
    item_id: text(d.item_id, 128),
    kind: d.kind as ArtifactDescriptor['kind'],
    content_hash: text(d.content_hash, 64),
    byte_size: Number(d.byte_size),
    chunk_count: Number(d.chunk_count),
    schema_version: text(d.schema_version, 128),
    producer_version: text(d.producer_version, 128),
    provenance: d.provenance as Record<string, unknown>,
    original_ref: d.original_ref === null ? null : text(d.original_ref, 128),
  };
  return c.json(
    await new ArtifactRepository(
      c.env.DB,
      access,
      diagnosticReservation(input),
    ).begin(
      descriptor,
      token(input.token, access.actorId),
      artifactTask(input.task_type),
      new Date(),
    ),
  );
});
workersApp.post('/artifacts/read', async (c) => {
  const input = await body(c, [
      'task_type',
      'token',
      'artifact_id',
      'chunk_index',
      'reservation_id',
    ]),
    access = c.get('access'),
    repository = new ArtifactRepository(
      c.env.DB,
      access,
      diagnosticReservation(input),
    ),
    lease = token(input.token, access.actorId),
    type = artifactTask(input.task_type),
    id = text(input.artifact_id, 128),
    now = new Date();
  if (input.chunk_index === undefined)
    return c.json({ artifact: await repository.get(id, lease, type, now) });
  if (!Number.isSafeInteger(input.chunk_index) || Number(input.chunk_index) < 0)
    throw new Error('INVALID_CHUNK_INDEX');
  return c.json({
    chunk: await repository.chunk(
      id,
      Number(input.chunk_index),
      lease,
      type,
      now,
    ),
  });
});
workersApp.post('/artifacts/write', async (c) => {
  const input = await body(c, [
      'task_type',
      'token',
      'artifact_id',
      'chunk_index',
      'byte_start',
      'body_base64',
      'reservation_id',
    ]),
    access = c.get('access');
  if (
    typeof input.body_base64 !== 'string' ||
    input.body_base64.length > 43692 ||
    !Number.isSafeInteger(input.chunk_index) ||
    !Number.isSafeInteger(input.byte_start)
  )
    throw new Error('INVALID_ARTIFACT_CHUNK');
  const bytes = input.body_base64
    ? decode64(input.body_base64)
    : new Uint8Array();
  return c.json(
    await new ArtifactRepository(
      c.env.DB,
      access,
      diagnosticReservation(input),
    ).writeChunk(
      text(input.artifact_id, 128),
      Number(input.chunk_index),
      Number(input.byte_start),
      bytes,
      token(input.token, access.actorId),
      artifactTask(input.task_type),
      new Date(),
    ),
  );
});
workersApp.post('/artifacts/verify-step', async (c) => {
  const input = await body(c, [
      'task_type',
      'token',
      'artifact_id',
      'proof',
      'reservation_id',
    ]),
    access = c.get('access');
  if (!c.env.SESSION_SIGNING_SECRET)
    throw new Error('AUTH_CONFIGURATION_REQUIRED');
  return c.json(
    await new ArtifactRepository(
      c.env.DB,
      access,
      diagnosticReservation(input),
    ).verifyStep(
      text(input.artifact_id, 128),
      token(input.token, access.actorId),
      artifactTask(input.task_type),
      new Date(),
      c.env.SESSION_SIGNING_SECRET,
      input.proof === undefined ? undefined : text(input.proof, 8192),
    ),
  );
});
workersApp.post('/lease', async (c) => {
  const input = await body(c, [
      'runtime',
      'task_type',
      'job_id',
      'analysis_mode',
    ]),
    access = c.get('access'),
    location = runtime(input.runtime);
  const store = new JobStore(c.env.DB, access),
    now = new Date();
  if (input.job_id !== undefined) {
    if (input.analysis_mode !== undefined) throw new Error('INVALID_TASK');
    const type = task(input.task_type);
    access.requireTask(type);
    const lease = await store.lease(
      text(input.job_id, 128),
      type,
      now,
      location,
    );
    if (!lease) throw new Error('STALE_FENCE');
    const job = await store.get(lease.job_id);
    return c.json({ leases: [{ token: lease, job }] });
  }
  const types =
    input.task_type === undefined ? undefined : [task(input.task_type)];
  if (input.analysis_mode !== undefined && input.analysis_mode !== 'PRODUCTION')
    throw new Error('INVALID_TASK');
  return c.json({
    leases: await pull(
      store,
      now,
      location,
      1,
      types,
      input.analysis_mode as 'PRODUCTION' | undefined,
    ),
  });
});
workersApp.post('/heartbeat', async (c) => {
  const input = await body(c, ['runtime', 'task_type', 'token']),
    access = c.get('access'),
    now = new Date(),
    location = runtime(input.runtime);
  let lease: LeaseToken | null = null;
  if (input.token !== undefined)
    lease = await new JobStore(c.env.DB, access).heartbeat(
      token(input.token, access.actorId),
      task(input.task_type),
      now,
      location,
    );
  else if (input.task_type !== undefined) throw new Error('INVALID_INPUT');
  await c.env.DB.prepare(
    `INSERT INTO worker_sessions(owner_id,worker_id,runtime,capabilities_json,heartbeat_at,online_until) SELECT owner_id,worker_id,?,scopes_json,?,? FROM worker_identities WHERE owner_id=? AND worker_id=? AND revoked_at IS NULL AND credential_hash=? ON CONFLICT(owner_id,worker_id) DO UPDATE SET runtime=excluded.runtime,capabilities_json=excluded.capabilities_json,heartbeat_at=excluded.heartbeat_at,online_until=excluded.online_until`,
  )
    .bind(
      location,
      now.toISOString(),
      new Date(now.getTime() + 180000).toISOString(),
      access.ownerId,
      access.actorId,
      access.credentialHash!,
    )
    .run();
  return c.json({ token: lease, server_time: now.toISOString() });
});
workersApp.post('/start', async (c) => {
  const input = await body(c, ['task_type', 'token']),
    access = c.get('access');
  await new JobStore(c.env.DB, access).start(
    token(input.token, access.actorId),
    task(input.task_type),
    new Date(),
  );
  return c.json({ state: 'RUNNING' });
});
workersApp.get('/transcript/admission', async (c) =>
  c.json(
    await new TranscriptRecovery(c.env.DB, c.get('access')).admission(
      new Date(),
      runtime(c.req.query('runtime')),
    ),
  ),
);
workersApp.post('/transcript/input', async (c) => {
  const input = await body(c, ['token']),
    access = c.get('access'),
    lease = token(input.token, access.actorId);
  access.requireTask('FETCH_TRANSCRIPT');
  const row = await c.env.DB.prepare(
    `SELECT i.item_id,i.namespace,i.external_id,r.metadata_json FROM jobs j JOIN items i ON i.owner_id=j.owner_id AND i.item_id=j.item_id JOIN item_revisions r ON r.owner_id=i.owner_id AND r.item_id=i.item_id AND r.revision_id=i.current_revision_id WHERE j.owner_id=? AND j.job_id=? AND j.task_type='FETCH_TRANSCRIPT' AND j.state='RUNNING' AND j.lease_owner=? AND j.fencing_token=? AND j.lease_until>?`,
  )
    .bind(
      access.ownerId,
      lease.job_id,
      access.actorId,
      lease.fencing_token,
      new Date().toISOString(),
    )
    .first<{
      item_id: string;
      namespace: string;
      external_id: string;
      metadata_json: string;
    }>();
  if (!row) throw new Error('STALE_FENCE');
  const metadata = JSON.parse(row.metadata_json) as {
    duration_seconds: number | null;
  };
  if (
    row.namespace !== 'youtube' ||
    !/^[A-Za-z0-9_-]{11}$/.test(row.external_id)
  )
    throw new Error('INVALID_TRANSCRIPT_ITEM');
  return c.json({
    item_id: row.item_id,
    namespace: 'youtube',
    external_id: row.external_id,
    duration_ms:
      metadata.duration_seconds === null
        ? null
        : metadata.duration_seconds * 1000,
  });
});
workersApp.post('/transcript/outcome', async (c) => {
  const input = await body(c, ['token', 'status', 'active_live']),
    access = c.get('access');
  if (
    !transcriptStatuses.some((status) => status === input.status) ||
    (input.active_live !== undefined && typeof input.active_live !== 'boolean')
  )
    throw new Error('INVALID_INPUT');
  const status = input.status as (typeof transcriptStatuses)[number];
  return c.json(
    await new TranscriptRecovery(c.env.DB, access).outcome(
      token(input.token, access.actorId),
      status,
      new Date(),
      input.active_live === true,
    ),
  );
});
workersApp.post('/transcript/accept', async (c) => {
  const input = await body(c, ['token', 'source']),
    access = c.get('access');
  if (
    !input.source ||
    typeof input.source !== 'object' ||
    Array.isArray(input.source)
  )
    throw new Error('INVALID_SOURCE_COMPLETION');
  const source = input.source as Record<string, unknown>;
  if (
    Object.keys(source).some(
      (key) =>
        ![
          'raw_artifact_id',
          'source_artifact_id',
          'normalized_artifact_id',
          'segment_map_artifact_id',
          'offset_map_artifact_id',
          'selection',
          'warnings',
        ].includes(key),
    )
  )
    throw new Error('INVALID_SOURCE_COMPLETION');
  for (const key of [
    'raw_artifact_id',
    'source_artifact_id',
    'normalized_artifact_id',
    'segment_map_artifact_id',
    'offset_map_artifact_id',
  ])
    text(source[key], 128);
  return c.json(
    await new TranscriptAcceptance(c.env.DB, access).accept(
      source as unknown as TranscriptSourceCompletion,
      token(input.token, access.actorId),
      new Date(),
    ),
  );
});
workersApp.post('/retry', async (c) => {
  const input = await body(c, ['task_type', 'token', 'code', 'reset_at']),
    access = c.get('access'),
    type = task(input.task_type),
    lease = token(input.token, access.actorId),
    store = new JobStore(c.env.DB, access),
    now = new Date();
  access.requireTask(type);
  const code = input.code;
  if (
    code !== 'TRANSIENT' &&
    code !== 'QUOTA' &&
    code !== 'AUTH' &&
    code !== 'INVALID_INPUT'
  )
    throw new Error('INVALID_REASON');
  const job = await store.get(lease.job_id);
  if (!job) throw new Error('NOT_FOUND');
  const decision = retryDisposition(
    code,
    job.attempt_count,
    now,
    Math.random,
    input.reset_at === undefined ? undefined : text(input.reset_at, 64),
  );
  await store.disposition(
    lease,
    type,
    decision.state,
    decision.reason,
    decision.due_at,
    now,
  );
  return c.json(decision);
});
workersApp.post('/defer', async (c) => {
  const input = await body(c, ['task_type', 'token', 'reason', 'due_at']),
    access = c.get('access'),
    due = text(input.due_at, 64),
    reason = text(input.reason, 64),
    type = task(input.task_type),
    now = new Date();
  if (
    ![
      'LOCAL_OFFLINE',
      'PROVIDER_UNAVAILABLE',
      'LIVE_ACTIVE',
      'MODEL_NOT_ELIGIBLE',
    ].includes(reason) ||
    (reason === 'MODEL_NOT_ELIGIBLE' && type !== 'ANALYZE') ||
    !Number.isFinite(Date.parse(due)) ||
    Date.parse(due) <= now.getTime() ||
    Date.parse(due) > now.getTime() + 86400000
  )
    throw new Error('INVALID_DEFER');
  await new JobStore(c.env.DB, access).disposition(
    token(input.token, access.actorId),
    type,
    'DEFERRED',
    reason,
    new Date(due).toISOString(),
    now,
  );
  return c.json({ state: 'DEFERRED', due_at: due, reason });
});
workersApp.post('/complete', async (c) => {
  const input = await body(c, ['task_type', 'token']),
    access = c.get('access'),
    type = task(input.task_type),
    lease = token(input.token, access.actorId);
  access.requireTask(type);
  const job = await new JobStore(c.env.DB, access).get(lease.job_id);
  if (
    !job ||
    job.task_type !== type ||
    job.fencing_token !== lease.fencing_token
  )
    throw new Error('STALE_FENCE');
  if (job.state === 'SUCCEEDED') {
    const accepted = await c.env.DB.prepare(
      'SELECT attempt_id FROM job_attempts WHERE owner_id=? AND job_id=? AND fencing_token=? AND executor_id=? AND finished_at IS NOT NULL',
    )
      .bind(access.ownerId, lease.job_id, lease.fencing_token, access.actorId)
      .first();
    if (!accepted) throw new Error('STALE_FENCE');
    return c.json({ state: 'SUCCEEDED', already_completed: true });
  }
  if (
    job.state !== 'RUNNING' ||
    job.lease_owner !== access.actorId ||
    !job.lease_until ||
    job.lease_until <= new Date().toISOString()
  )
    throw new Error('STALE_FENCE');
  // Discovery validates/commits its own upstream data. Generic AI acceptance awaits Stage 03 validator.
  if (type !== 'DISCOVER' && type !== 'RECONCILE')
    throw new Error('CAPABILITY_NOT_AVAILABLE');
  if (!c.env.YOUTUBE_API_KEY)
    throw new Error('PROVIDER_CONFIGURATION_REQUIRED');
  return c.json(
    await executeDiscoveryChunk(
      c.env.DB,
      access,
      lease,
      new YoutubeClient(c.env.YOUTUBE_API_KEY, 3),
      new Date(),
      type,
      () => new Date(),
      4,
    ),
  );
});
workersApp.post('/control-tick', async (c) => {
  await body(c, []);
  if (
    !c.env.CONTROL_WORKER_CREDENTIAL ||
    c.req.header('Authorization') !==
      `Bearer ${c.env.CONTROL_WORKER_CREDENTIAL}`
  )
    throw new Error('FORBIDDEN');
  return c.json(await controlTick(c.env, c.get('access')));
});
