import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import {
  restoreCanonical,
  type PortableCoreBackup,
} from '../../../packages/core/src/backup/restore.js';
import {
  AccessContext,
  type Database,
} from '../../../packages/core/src/db/boundary.js';
import { sha256, randomToken } from '../../../packages/core/src/auth/crypto.js';
import { JobStore } from '../../../packages/core/src/jobs/store.js';
import { sweep } from '../../../packages/core/src/jobs/recovery.js';
import { TranscriptRecovery } from '../../../packages/core/src/transcript/recovery.js';
import {
  TranscriptAcceptance,
  type TranscriptSourceCompletion,
} from '../../../packages/core/src/transcript/acceptance.js';
import {
  ArtifactRepository,
  artifactChunkBytes,
} from '../../../packages/core/src/artifacts/store.js';
import type { LeaseToken } from '../../../packages/contracts/src/jobs.js';
import type { TranscriptStatus } from '../../../packages/contracts/src/transcript.js';
import {
  executeTranscript,
  type TranscriptLifecycle,
} from '../../../apps/executor/src/transcript-runner.js';
import {
  YtdlpTranscriptProvider,
  runYtdlpProcess,
  ytdlpProviderVersion,
} from '../../../apps/executor/src/providers/ytdlp.js';
import type { ArtifactClient } from '../../../apps/executor/src/artifact-client.js';
import { requirePrivateRecoveryDirectory } from '../../db/private-directory.js';
import { candidatePins } from '../../release/pins.js';

// Actual provider process fault/recovery on the approved video. This receipt
// does not replace the frozen Gate R baseline or combine different pins.
const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  args[0] !== '--drive-copy' ||
  args[2] !== '--live-video' ||
  args[3] !== 'rUhllpnYWR8' ||
  !process.env.GOOGLE_OIDC_OWNER_SUBJECT
)
  throw new Error('EXPLICIT_APPROVED_TRANSCRIPT_RECOVERY_REQUIRED');
const pins = candidatePins(),
  id = randomUUID();
const bytes = readFileSync(args[1]!);
if (bytes.length > 64 * 1024 * 1024) throw new Error('BACKUP_FILE_TOO_LARGE');
const backupHash = createHash('sha256').update(bytes).digest('hex');
const verified = JSON.parse(
  readFileSync(
    'docs/verification/backup/drive-5a30668c-f9f2-4aae-b965-b9e15dc9c073-restore.json',
    'utf8',
  ),
);
if (verified.status !== 'PASS' || verified.archive_sha256 !== backupHash)
  throw new Error('VERIFIED_INDEPENDENT_COPY_REQUIRED');
const portable = JSON.parse(bytes.toString('utf8')) as PortableCoreBackup;
const privateRoot = resolve('.local/transcript-provider-recovery', id);
requirePrivateRecoveryDirectory(privateRoot);
const output = resolve('docs/verification/gate-r/provider-transcript-' + id);
mkdirSync(output, { recursive: true });
const save = (name: string, value: unknown) => {
  const data = JSON.stringify(value, null, 2) + '\n';
  writeFileSync(join(output, name), data, { flag: 'wx' });
  return createHash('sha256').update(data).digest('hex');
};
const preregistrationHash = save('preregistration.json', {
  version: 'TranscriptProviderRecoveryPreregistration/1.0',
  pins,
  registered_at: new Date().toISOString(),
  video_id: args[3],
  backup_sha256: backupHash,
  fault: 'REAL_YTDLP_CHILD_PROCESS_TIMEOUT_1MS_AFTER_SUCCESSFUL_REAL_LISTING',
  recovery:
    'PERSISTED_LOCAL_D1_RUNTIME_RESTART_NEW_EXECUTOR_CONTEXT_REAL_YTDLP_SOURCE_ACCEPTANCE',
  deadline_ms: 14400000,
  scope: 'ACTUAL_PROVIDER_RECOVERY_ONLY_NOT_FULL_GATE_R',
  production_d1_requests: 0,
  gemini_requests: 0,
  paid_services_enabled: false,
});
const require = createRequire(import.meta.url),
  wrangler = createRequire(require.resolve('wrangler/package.json'));
const runtime = wrangler('miniflare') as {
  convertV4MiniflareOptions(
    options: Record<string, unknown>,
  ): Record<string, unknown>;
  Miniflare: new (options: Record<string, unknown>) => {
    ready: Promise<URL>;
    getD1Database(name: string): Promise<Database>;
    dispose(): Promise<void>;
  };
};
const open = () =>
  new runtime.Miniflare({
    ...runtime.convertV4MiniflareOptions({
      modules: true,
      script:
        'export default {fetch(){return new Response("ISOLATED_TRANSCRIPT_RECOVERY")}}',
      host: '127.0.0.1',
      port: 0,
      d1Databases: ['DB'],
    }),
    resourcePersistencePath: privateRoot,
  });
let mf = open();
let phase = 'RESTORE',
  processInvocations = 0,
  controlledTimeouts = 0;
let result: Record<string, unknown> = {};
const started = performance.now();
try {
  await mf.ready;
  let db = await mf.getD1Database('DB');
  for (const migration of await readD1Migrations('db/migrations'))
    for (const sql of migration.queries) await db.prepare(sql).run();
  await restoreCanonical(db, portable, process.env.GOOGLE_OIDC_OWNER_SUBJECT);
  const ownerId = portable.manifest.owner_id;
  const canonicalItem = await db
    .prepare(
      `SELECT i.item_id,i.source_id,i.external_id,i.namespace,i.current_revision_id,
       json_extract(r.metadata_json,'$.duration_seconds') duration_seconds FROM items i
       JOIN item_revisions r ON r.owner_id=i.owner_id AND r.item_id=i.item_id AND r.revision_id=i.current_revision_id
       WHERE i.owner_id=? AND i.external_id=?`,
    )
    .bind(ownerId, args[3]!)
    .first<{
      item_id: string;
      source_id: string;
      external_id: string;
      namespace: 'youtube';
      current_revision_id: string;
      duration_seconds: number | null;
    }>();
  if (!canonicalItem || canonicalItem.namespace !== 'youtube')
    throw new Error('APPROVED_CANONICAL_ITEM_REQUIRED');
  const item = {
    ...canonicalItem,
    duration_ms:
      canonicalItem.duration_seconds === null
        ? null
        : canonicalItem.duration_seconds * 1000,
  };
  const session = await sha256(randomToken()),
    credential = await sha256(randomToken());
  const now = new Date();
  await db
    .prepare('INSERT INTO owner_sessions VALUES(?,?,?,?,?)')
    .bind(
      session,
      ownerId,
      await sha256(randomToken()),
      now.toISOString(),
      new Date(now.getTime() + 900000).toISOString(),
    )
    .run();
  await db
    .prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'transcript-recovery-' + id,
      ownerId,
      credential,
      '["FETCH_TRANSCRIPT"]',
      now.toISOString(),
    )
    .run();
  const owner = await AccessContext.owner(db, session, now.toISOString());
  let worker = await AccessContext.worker(db, credential),
    store = new JobStore(db, worker);
  const job = (await new JobStore(db, owner).enqueue(
    {
      item_id: item.item_id,
      source_id: item.source_id,
      task_type: 'FETCH_TRANSCRIPT',
      input_revision: item.current_revision_id,
      profile_revision: 'local',
      routing_policy_version: 'local-primary-1',
      prompt_snapshot_id: null,
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: id,
      arrival_origin_at: now.toISOString(),
      origin_kind: 'BACKFILL',
      payload: { video_id: args[3] },
      priority: 20,
      due_at: now.toISOString(),
    },
    now.toISOString(),
  ))!;
  const requestContext = () => ({
    job_id: job.job_id,
    item_id: item.item_id,
    quota_reservation_id: null,
    runtime_id: 'local' as const,
    deadline: new Date(Date.now() + 120000).toISOString(),
    request_id: randomUUID(),
    provider_version: ytdlpProviderVersion,
    max_bytes: 4 * 1024 * 1024,
  });
  let sourceCompletion: TranscriptSourceCompletion | null = null;
  let cueCount = 0,
    rawBytes = 0,
    rawHash: string | null = null;
  const realProvider = () => {
    const provider = new YtdlpTranscriptProvider(async (input, timeout) => {
      processInvocations++;
      return runYtdlpProcess(input, timeout);
    });
    const fetchActual = provider.fetch.bind(provider);
    provider.fetch = async (...params) => {
      const fetched = await fetchActual(...params);
      cueCount = fetched.result.segments.length;
      rawBytes = fetched.raw_payload?.length ?? 0;
      rawHash = fetched.result.raw_payload_hash;
      return fetched;
    };
    return provider;
  };
  phase = 'ACTUAL_PROVIDER_PREFLIGHT';
  const listing = await realProvider().list_tracks(item, requestContext());
  if (listing.status !== 'OK')
    throw new Error('ACTUAL_PROVIDER_PREFLIGHT_' + listing.status);
  const first = (await store.lease(
    job.job_id,
    'FETCH_TRANSCRIPT',
    new Date(),
    'local',
  ))!;
  if (!first) throw new Error('INITIAL_LEASE_REQUIRED');
  await store.start(first, 'FETCH_TRANSCRIPT', new Date());
  let recovery = new TranscriptRecovery(db, worker),
    activeToken: LeaseToken = first;
  let acceptedRun: string | null = null,
    failedState: string | null = null;
  const lifecycle = (): TranscriptLifecycle => ({
    admission: () => recovery.admission(new Date(), 'local'),
    heartbeat: async () => {
      activeToken = await store.heartbeat(
        activeToken,
        'FETCH_TRANSCRIPT',
        new Date(),
        'local',
      );
    },
    outcome: async (status: TranscriptStatus) => {
      // Legal zero jitter avoids artificial clock advance, without changing retry policy.
      failedState = (
        await recovery.outcome(activeToken, status, new Date(), false, () => 0)
      ).state;
    },
    diagnostic: async () => {
      throw new Error('TRANSCRIPT_RECOVERY_DIAGNOSTIC');
    },
    accept: async (source) => {
      sourceCompletion = source;
      acceptedRun = (
        await new TranscriptAcceptance(db, worker).accept(
          source,
          activeToken,
          new Date(),
        )
      ).run_id;
    },
  });
  const uploads = (): Pick<ArtifactClient, 'upload'> => ({
    upload: async (text, descriptor) => {
      const body = new TextEncoder().encode(text),
        artifacts = new ArtifactRepository(db, worker);
      const artifact = await artifacts.begin(
        {
          ...descriptor,
          content_hash: await sha256(text),
          byte_size: body.length,
          chunk_count: Math.max(1, Math.ceil(body.length / artifactChunkBytes)),
        },
        activeToken,
        'FETCH_TRANSCRIPT',
        new Date(),
      );
      if (artifact.state === 'VERIFIED') return artifact;
      for (
        let offset = 0, index = 0;
        index < artifact.chunk_count;
        index++, offset += artifactChunkBytes
      )
        await artifacts.writeChunk(
          artifact.artifact_id,
          index,
          offset,
          body.slice(offset, offset + artifactChunkBytes),
          activeToken,
          'FETCH_TRANSCRIPT',
          new Date(),
        );
      return artifacts.verifyLocal(
        artifact.artifact_id,
        activeToken,
        'FETCH_TRANSCRIPT',
        new Date(),
        'local',
      );
    },
  });
  phase = 'CONTROLLED_PROCESS_TIMEOUT';
  const failureProvider = new YtdlpTranscriptProvider(async (input) => {
    processInvocations++;
    try {
      await runYtdlpProcess(input, 1);
    } catch {
      controlledTimeouts++;
      throw new Error('PREREGISTERED_PROCESS_TIMEOUT');
    }
    throw new Error('PROCESS_TIMEOUT_NOT_OBSERVED');
  });
  const recoveryStarted = performance.now();
  const failed = await executeTranscript(
    item,
    requestContext(),
    failureProvider,
    uploads(),
    lifecycle(),
  );
  if (
    controlledTimeouts !== 1 ||
    failed.accepted ||
    failedState !== 'RETRY_WAIT'
  )
    throw new Error('DURABLE_FAULT_DISPOSITION_REQUIRED');
  phase = 'PERSISTED_RUNTIME_RESTART';
  await mf.dispose();
  mf = open();
  await mf.ready;
  db = await mf.getD1Database('DB');
  worker = await AccessContext.worker(db, credential);
  store = new JobStore(db, worker);
  recovery = new TranscriptRecovery(db, worker);
  for (
    let attempt = 0;
    attempt < 10 && (await store.get(job.job_id))!.state !== 'PENDING';
    attempt++
  )
    await sweep(db, new Date(), () => true, 50);
  activeToken = (await store.lease(
    job.job_id,
    'FETCH_TRANSCRIPT',
    new Date(),
    'local',
  ))!;
  if (!activeToken) throw new Error('PERSISTED_RETRY_LEASE_REQUIRED');
  await store.start(activeToken, 'FETCH_TRANSCRIPT', new Date());
  let staleRejected = false;
  try {
    await recovery.outcome(first, 'UNAVAILABLE', new Date());
  } catch (error) {
    staleRejected = error instanceof Error && error.message === 'STALE_FENCE';
  }
  phase = 'REAL_SOURCE_ACCEPTANCE';
  const recovered = await executeTranscript(
    item,
    requestContext(),
    realProvider(),
    uploads(),
    lifecycle(),
  );
  const final = (await store.get(job.job_id))!;
  if (recovered.accepted && sourceCompletion)
    await new TranscriptAcceptance(db, worker).accept(
      sourceCompletion,
      activeToken,
      new Date(),
    );
  const effects = await db
    .prepare(
      "SELECT COUNT(*) n FROM analysis_runs WHERE owner_id=? AND job_id=? AND state='ACCEPTED'",
    )
    .bind(ownerId, job.job_id)
    .first<number>('n');
  const pass =
    recovered.accepted &&
    acceptedRun !== null &&
    effects === 1 &&
    final.state === 'SUCCEEDED' &&
    activeToken.fencing_token > first.fencing_token &&
    staleRejected &&
    final.arrival_origin_at === job.arrival_origin_at &&
    final.origin_kind === job.origin_kind;
  result = {
    status: pass ? 'PASS' : 'FAIL',
    scope: 'ACTUAL_PROVIDER_RECOVERY_ONLY_NOT_FULL_GATE_R',
    preregistration_sha256: preregistrationHash,
    pins,
    backup_sha256: backupHash,
    actual_provider_preflight: 'OK',
    raw_bytes: rawBytes,
    raw_payload_sha256: rawHash,
    cues: cueCount,
    controlled_process_timeouts: controlledTimeouts,
    process_invocations: processInvocations,
    failed_state: failedState,
    runtime_restarted: true,
    first_fence: first.fencing_token,
    recovery_fence: activeToken.fencing_token,
    stale_fence_rejected: staleRejected,
    accepted_source_effects: effects,
    final_state: final.state,
    origin_preserved:
      final.arrival_origin_at === job.arrival_origin_at &&
      final.origin_kind === job.origin_kind,
    recovery_elapsed_ms: Math.ceil(performance.now() - recoveryStarted),
    total_elapsed_ms: Math.ceil(performance.now() - started),
    logical_clock: false,
    synthetic_provider_status: false,
    production_d1_requests: 0,
    gemini_requests: 0,
    paid_services_enabled: false,
    frozen_gate_r_status: 'UNCHANGED_REQUIRES_COMPATIBLE_CURRENT_BASELINE',
  };
  if (!pass) process.exitCode = 2;
} catch (error) {
  const code = error instanceof Error ? error.message : '';
  result = {
    status: 'FAIL',
    phase,
    reason: /^[A-Z_0-9]+$/.test(code) ? code : 'REDACTED_FAILURE',
    preregistration_sha256: preregistrationHash,
    pins,
    process_invocations: processInvocations,
    controlled_process_timeouts: controlledTimeouts,
    production_d1_requests: 0,
    gemini_requests: 0,
    paid_services_enabled: false,
  };
  process.exitCode = 2;
} finally {
  await mf.dispose();
  save('receipt.json', {
    version: 'TranscriptProviderRecovery/1.0',
    observed_at: new Date().toISOString(),
    ...result,
  });
  console.log(
    JSON.stringify({ ...result, evidence: join(output, 'receipt.json') }),
  );
  await delay(1);
}
