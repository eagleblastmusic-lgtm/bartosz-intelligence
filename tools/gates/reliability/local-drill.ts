import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import type { Database } from '../../../packages/core/src/db/boundary.js';
import { AccessContext } from '../../../packages/core/src/db/boundary.js';
import {
  restoreCanonical,
  type PortableCoreBackup,
} from '../../../packages/core/src/backup/restore.js';
import { JobStore } from '../../../packages/core/src/jobs/store.js';
import { RunRepository } from '../../../packages/core/src/jobs/acceptance.js';
import {
  dispatchOutbox,
  sweep,
} from '../../../packages/core/src/jobs/recovery.js';
import { sha256, randomToken } from '../../../packages/core/src/auth/crypto.js';
import { candidatePins } from '../../release/pins.js';
import { requirePrivateRecoveryDirectory } from '../../db/private-directory.js';
import { evidenceHash } from '../drive-evidence.js';
import {
  evaluateRecovery,
  recoveryCases,
  type GateRManifest,
} from './evaluate.js';
import ledger from '../../../db/migration-ledger.json';
import deployment from '../../../config/deployment.json';
import { drillDiscovery } from './local-discovery.js';
import { drillAuth } from './local-auth.js';

// Isolated local D1 only; no production mutation or source/AI provider request.
const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  args[0] !== '--backup' ||
  args[2] !== '--receipt' ||
  !process.env.GOOGLE_OIDC_OWNER_SUBJECT
)
  throw new Error('EXPLICIT_PRIVATE_BACKUP_RECEIPT_REQUIRED');
const pins = candidatePins();
if (
  statSync(args[1]!).size > 64 * 1024 * 1024 ||
  statSync(args[3]!).size > 256 * 1024
)
  throw new Error('DRILL_INPUT_TOO_LARGE');
const parsePrivate = (data: Uint8Array) => {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    throw new Error('INVALID_PRIVATE_DRILL_JSON');
  }
};
const bytes = readFileSync(args[1]!);
if (bytes.length > 64 * 1024 * 1024) throw new Error('BACKUP_FILE_TOO_LARGE');
const portable = parsePrivate(bytes) as PortableCoreBackup;
const backupReceiptBytes = readFileSync(args[3]!);
const backupReceipt = parsePrivate(backupReceiptBytes);
if (
  backupReceipt.backup_sha256 !== evidenceHash(bytes) ||
  backupReceipt.independent_sqlite_restore !== 'PASS'
)
  throw new Error('VERIFIED_BACKUP_RECEIPT_REQUIRED');
const id = randomUUID();
const privateDirectory = resolve('.local/gate-r', id);
requirePrivateRecoveryDirectory(privateDirectory);
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const runtime = wranglerRequire('miniflare') as {
  convertV4MiniflareOptions(
    options: Record<string, unknown>,
  ): Record<string, unknown>;
  Miniflare: new (options: Record<string, unknown>) => {
    ready: Promise<URL>;
    getD1Database(name: string): Promise<Database>;
    dispose(): Promise<void>;
  };
};
const mf = new runtime.Miniflare(
  runtime.convertV4MiniflareOptions({
    modules: true,
    script:
      'export default {fetch(){return new Response("ISOLATED_RECOVERY_ONLY")}}',
    host: '127.0.0.1',
    port: 0,
    d1Databases: ['DB'],
    d1Persist: privateDirectory,
  }),
);
const output = resolve('docs/verification/gate-r', id);
if (existsSync(output)) throw new Error('DRILL_EVIDENCE_EXISTS');
const files = new Map<string, Uint8Array>();
const saveBytes = (name: string, data: Uint8Array) => {
  writeFileSync(join(output, name), data, { flag: 'wx' });
  files.set(name, data);
  return { path: name, sha256: evidenceHash(data) };
};
const save = (name: string, value: unknown) =>
  saveBytes(
    name,
    new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n'),
  );
try {
  const origin = (await mf.ready).origin;
  const db = await mf.getD1Database('DB');
  const migrations = await readD1Migrations('db/migrations');
  for (const migration of ledger.migrations) {
    // Use the same official parser as the existing Workers test harness.
    const parsed = migrations.find((row) => row.name === migration.name);
    if (!parsed) throw new Error('DRILL_MIGRATION_MISSING');
    for (const query of parsed.queries) await db.prepare(query).run();
  }
  const restored = await restoreCanonical(
    db,
    portable,
    process.env.GOOGLE_OIDC_OWNER_SUBJECT!,
  );
  mkdirSync(output, { recursive: true });
  const configuration = save('configuration.json', {
    version: 'GateRConfiguration/1.0',
    candidate_sha256: pins.candidate_sha256,
    migration_set_sha256: pins.migration_set_sha256,
    migration_count: pins.migration_count,
    target_origin: origin,
    isolated_database_id: 'local-d1-' + id,
    production_database_id: deployment.database_id,
    owner_pseudonym: 'OWNER_A',
    paid_services_enabled: false,
  });
  const backupRef = saveBytes('backup-receipt.json', backupReceiptBytes);
  const origins = async () =>
    (
      await db
        .prepare(
          'SELECT job_id,arrival_origin_at,origin_kind FROM jobs ORDER BY job_id',
        )
        .all<{
          job_id: string;
          arrival_origin_at: string;
          origin_kind: string;
        }>()
    ).results;
  const originalOrigins = await origins();
  const counts: Record<string, number> = {};
  for (const table of [
    'items',
    'jobs',
    'analysis_runs',
    'evidence',
    'observations',
  ])
    counts[table] = (await db
      .prepare(`SELECT COUNT(*) n FROM ${table}`)
      .first<number>('n'))!;
  const baseline = save('baseline.json', {
    version: 'GateRBaseline/1.0',
    configuration_sha256: configuration.sha256,
    backup_sha256: evidenceHash(bytes),
    backup_receipt: backupRef,
    restore_verified: restored.result === 'PASS',
    cut_seq: portable.manifest.cut_seq,
    counts,
    origin_set_sha256: await sha256(JSON.stringify(originalOrigins)),
  });
  // Freeze acceptance bounds before any injection. Logical clock advancement
  // simulates transport expiry; actual database leases/fences are exercised.
  save('preregistration.json', {
    version: 'LocalD1RecoveryDrill/1.0',
    cases: [
      'lease_crash',
      'queue_loss',
      'database_rollback',
      'discovery_interruption',
      'auth_revocation',
    ],
    deadline_ms: 14400000,
    provider_requests: 0,
    synthetic_result: true,
    logical_transport_outage_hours: 26,
  });
  const started = performance.now();
  const now = new Date(),
    old = new Date(now.getTime() - 26 * 3600000);
  const ownerId = portable.manifest.owner_id;
  const session = await sha256(randomToken());
  await db
    .prepare(
      'INSERT INTO owner_sessions(session_hash,owner_id,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?)',
    )
    .bind(
      session,
      ownerId,
      await sha256(randomToken()),
      now.toISOString(),
      new Date(now.getTime() + 900000).toISOString(),
    )
    .run();
  const owner = await AccessContext.owner(db, session, now.toISOString());
  const job = (await new JobStore(db, owner).enqueue(
    {
      item_id: null,
      source_id: null,
      task_type: 'FETCH_TRANSCRIPT',
      input_revision: id,
      profile_revision: 'local',
      routing_policy_version: 'local-primary-1',
      prompt_snapshot_id: null,
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: old.toISOString(),
      origin_kind: 'BACKFILL',
      payload: {},
      priority: 20,
      due_at: old.toISOString(),
    },
    old.toISOString(),
  ))!;
  const contexts: AccessContext[] = [];
  for (const label of ['first', 'second']) {
    const credential = await sha256(randomToken());
    await db
      .prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
      .bind(
        'drill-' + label,
        ownerId,
        credential,
        '["FETCH_TRANSCRIPT"]',
        old.toISOString(),
      )
      .run();
    contexts.push(await AccessContext.worker(db, credential));
  }
  const stores = contexts.map((context) => new JobStore(db, context));
  const crashed = (await stores[0]!.lease(
    job.job_id,
    'FETCH_TRANSCRIPT',
    old,
    'local',
  ))!;
  await stores[0]!.start(crashed, 'FETCH_TRANSCRIPT', old);
  const originalRun = new RunRepository(db, contexts[0]!);
  await originalRun.prepare('drill-crashed', job.job_id, old.toISOString());
  await dispatchOutbox(db, async () => {}, old);
  await sweep(db, now, () => true);
  const leases = await Promise.all(
    stores.map((store) =>
      store.lease(job.job_id, 'FETCH_TRANSCRIPT', now, 'local'),
    ),
  );
  if (leases.filter(Boolean).length !== 1)
    throw new Error('DRILL_LEASE_INVARIANT');
  const winner = leases.findIndex(Boolean),
    token = leases[winner]!;
  await stores[winner]!.start(token, 'FETCH_TRANSCRIPT', now);
  const outcome = { version: 'isolated-recovery-drill:1' },
    hash = await sha256(JSON.stringify(outcome));
  let staleRejected = false;
  try {
    await originalRun.complete(
      crashed,
      'FETCH_TRANSCRIPT',
      'drill-crashed',
      hash,
      outcome,
      null,
      now,
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'STALE_FENCE')
      staleRejected = true;
    else throw error;
  }
  const runs = new RunRepository(db, contexts[winner]!);
  await runs.prepare('drill-recovered', job.job_id, now.toISOString());
  // Fail after the commit guard and accepted-run update inside the actual D1
  // transaction. A subsequent valid completion must recover without leftovers.
  const interrupted = new RunRepository(
    {
      prepare: db.prepare.bind(db),
      batch: (statements) =>
        db.batch([
          ...statements.slice(0, 2),
          db.prepare('INSERT INTO isolated_drill_missing_table VALUES(1)'),
          ...statements.slice(2),
        ]),
    },
    contexts[winner]!,
  );
  let transactionRejected = false;
  try {
    await interrupted.complete(
      token,
      'FETCH_TRANSCRIPT',
      'drill-recovered',
      hash,
      outcome,
      null,
      now,
    );
  } catch {
    transactionRejected = true;
  }
  const rollbackVerified =
    transactionRejected &&
    (await stores[winner]!.get(job.job_id))?.state === 'RUNNING' &&
    (await db
      .prepare('SELECT state FROM analysis_runs WHERE run_id=?')
      .bind('drill-recovered')
      .first<string>('state')) === 'CANDIDATE' &&
    (await db
      .prepare(
        'SELECT commit_nonce FROM job_attempts WHERE job_id=? AND fencing_token=?',
      )
      .bind(job.job_id, token.fencing_token)
      .first<string>('commit_nonce')) === null;
  const accepted = await runs.complete(
    token,
    'FETCH_TRANSCRIPT',
    'drill-recovered',
    hash,
    outcome,
    null,
    now,
  );
  const repeated = await runs.complete(
    token,
    'FETCH_TRANSCRIPT',
    'drill-recovered',
    hash,
    outcome,
    null,
    now,
  );
  const discovery = await drillDiscovery(db, owner, now);
  save('discovery-observations.json', discovery.observations);
  const auth = await drillAuth(db, owner, session, now);
  save('auth-observations.json', auth.observations);
  const after = await origins();
  const originalIds = new Set(originalOrigins.map((row) => row.job_id));
  const originsPreserved =
    JSON.stringify(after.filter((row) => originalIds.has(row.job_id))) ===
    JSON.stringify(originalOrigins);
  const completed = await stores[winner]!.get(job.job_id);
  const acceptedCount = await db
    .prepare(
      "SELECT COUNT(*) n FROM analysis_runs WHERE job_id=? AND state='ACCEPTED'",
    )
    .bind(job.job_id)
    .first<number>('n');
  const pass =
    rollbackVerified &&
    staleRejected &&
    accepted.accepted &&
    repeated.duplicate &&
    completed?.state === 'SUCCEEDED' &&
    completed.arrival_origin_at === job.arrival_origin_at &&
    completed.origin_kind === job.origin_kind &&
    originsPreserved &&
    acceptedCount === 1;
  const rows: GateRManifest['cases'] = [];
  for (const caseId of recoveryCases) {
    let evidence = null;
    const casePass =
      pass &&
      (caseId === 'discovery_interruption'
        ? discovery.pass
        : caseId === 'auth_revocation'
          ? auth.pass
          : true);
    if (
      [
        'lease_crash',
        'queue_loss',
        'database_rollback',
        'discovery_interruption',
        'auth_revocation',
      ].includes(caseId)
    )
      evidence = save(caseId + '.json', {
        version: 'GateRCase/1.0',
        case_id: caseId,
        configuration_sha256: configuration.sha256,
        baseline_sha256: baseline.sha256,
        kind: 'ACTUAL_LOCAL_D1',
        observed_at: new Date().toISOString(),
        result: casePass ? 'PASS' : 'FAIL',
        lost_jobs:
          originalOrigins.length -
          after.filter((row) => originalIds.has(row.job_id)).length,
        duplicate_effects: Math.max(0, (acceptedCount ?? 0) - 1),
        stale_writes: staleRejected ? 0 : 1,
        origins_preserved: originsPreserved,
        recovered: casePass,
        paid_requests: 0,
        recovery_elapsed_ms: Math.ceil(performance.now() - started),
      });
    rows.push({ id: caseId, deadline_ms: 14400000, evidence });
  }
  const manifest: GateRManifest = {
    version: 'GateRManifest/1.0',
    configuration,
    baseline,
    cases: rows,
  };
  save('manifest.json', manifest);
  const report = evaluateRecovery(
    manifest,
    (path) => {
      const data = files.get(path);
      if (!data) throw new Error('DRILL_EVIDENCE_MISSING');
      return data;
    },
    new Date(),
    pins,
  );
  save('report.json', report);
  console.log(
    JSON.stringify({
      status: report.status,
      qualified_cases: report.rows
        .filter((row) => row.status === 'PASS')
        .map((row) => row.id),
      evidence: output,
      provider_requests: 0,
      global_release_approved: false,
    }),
  );
  if (!pass || !discovery.pass || !auth.pass) process.exitCode = 2;
} finally {
  await mf.dispose();
}
