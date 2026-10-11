import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { candidatePins } from '../../release/pins.js';
import { sqliteAdapter } from '../../db/sqlite-adapter.js';
import { requirePrivateRecoveryDirectory } from '../../db/private-directory.js';
import { restoreCanonical } from '../../../packages/core/src/backup/restore.js';
import { AccessContext } from '../../../packages/core/src/db/boundary.js';
import { sha256, randomToken } from '../../../packages/core/src/auth/crypto.js';
import { ItemRepository } from '../../../packages/core/src/db/items.js';
import { JobStore } from '../../../packages/core/src/jobs/store.js';
import { DriveClient } from '../../../packages/core/src/drive/client.js';
import { DriveExportIdentity } from '../../../packages/core/src/drive/identity.js';
import { importDriveWrappingKey } from '../../../packages/core/src/drive/credentials.js';
import { refreshDriveAccess } from '../../../packages/core/src/drive/oauth.js';
import { runDriveExportTick } from '../../../packages/core/src/export/runtime.js';
import { ExportDirtyDays } from '../../../packages/core/src/export/dirty.js';
import { DailyExportArtifacts } from '../../../packages/core/src/export/artifacts.js';
import { queryBatch, remoteDatabase } from '../../deployment/cloudflare.mjs';
import { d1TestBudget } from '../../deployment/d1-test-budget.js';
import { d1UsagePolicy } from '../../deployment/d1-usage-policy.js';
import ledger from '../../../db/migration-ledger.json';
import defaults from '../../../config/defaults.json';

// One disposable private canary. All canonical mutations and fault injection
// are isolated; production D1 is used only to obtain the existing scoped grant.
const args = process.argv.slice(2),
  mode = args[0];
if (
  !(args.length === 1 && mode === '--start') &&
  !(
    args.length === 2 &&
    ['--resume', '--continue-setup'].includes(mode!) &&
    /^[a-f0-9-]{36}$/.test(args[1]!)
  )
)
  throw new Error('EXPLICIT_DRIVE_CONSUMER_DRILL_REQUIRED');
if (defaults.paid_services_enabled !== false)
  throw new Error('PAID_POLICY_DENIED');
if (!process.env.GOOGLE_OIDC_OWNER_SUBJECT)
  throw new Error('PRIVATE_OWNER_BINDING_REQUIRED');
const day = new Date().toISOString().slice(0, 10);
const sample = JSON.parse(readFileSync('.local/d1-usage/latest.json', 'utf8'));
if (!d1UsagePolicy(sample, new Date()).noncritical_admitted)
  throw new Error('FRESH_D1_ANALYTICS_REQUIRED');
const id = mode === '--start' ? randomUUID() : args[1]!;
const root = resolve('.local/drive-consumer-recovery', id);
requirePrivateRecoveryDirectory(root);
const output = resolve(
  'docs/verification/gate-r/provider-drive-consumer-' + id,
);
mkdirSync(output, { recursive: true });
const save = (name: string, value: unknown) =>
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
type Journal = {
  owner_id: string;
  credential_hash: string;
  cursor_secret: string;
  connection_id: string;
  phase: 'SETUP' | 'WAITING_RETRY' | 'VERIFIED';
  file_id: string | null;
  artifact_id: string | null;
  next_retry_at: string | null;
  started_at: string;
  source_id: string;
  pending_job_id: string | null;
  creates: number;
};
let journal: Journal;
const journalPath = join(root, 'journal.json');
const canaryRoot = '1rn_5auxY_8HAeADc1RgGKQ6h9JimD7WM',
  date = '2000-01-01';
const pins = candidatePins();
if (mode === '--start') {
  const intent = resolve(
    '.local/drive-consumer-recovery',
    day + '-intent.json',
  );
  if (existsSync(intent))
    throw new Error('DRIVE_CONSUMER_TRIAL_ALREADY_STARTED');
  writeFileSync(
    intent,
    JSON.stringify({
      id,
      started_at: new Date().toISOString(),
      maximum_create_attempts: 1,
      existing_files_modified: false,
    }) + '\n',
    { flag: 'wx' },
  );
  const backupId = 'fbf01a86-3ddb-414d-bc96-05c489262fbd';
  const bytes = readFileSync(
    '.local/drive-backups/' + backupId + '-downloaded.json',
  );
  const proof = JSON.parse(
    readFileSync(
      'docs/verification/backup/drive-' + backupId + '-restore.json',
      'utf8',
    ),
  );
  if (proof.status !== 'PASS' || proof.archive_sha256 !== digest(bytes))
    throw new Error('VERIFIED_INDEPENDENT_BACKUP_REQUIRED');
  save('preregistration.json', {
    version: 'DriveConsumerProviderRecovery/1.0',
    pins,
    recorded_at: new Date().toISOString(),
    backup_id: backupId,
    backup_sha256: digest(bytes),
    case_id: 'drive_consumer_failure',
    root_id: canaryRoot,
    maximum_create_attempts: 1,
    injection:
      'DISCARD_ACTUAL_CREATE_SUCCESS_AND_INTERRUPT_CONSUMER_RECONCILIATION',
    targets: [
      'SAME_SEALED_ARTIFACT',
      'DURABLE_PROCESS_RESTART',
      'SAME_FILE_ID',
      'NO_SECOND_CREATE',
      'CORE_INTAKE_DURING_FAILURE',
      'LATE_CHANGE_REMAINS_DIRTY',
    ],
    fixture: 'ISOLATED_SYNTHETIC_PENDING_ITEMS_NO_AI_RESULT',
    production_reports_or_source_data_modified: false,
    logical_clock: false,
    gemini_requests: 0,
    paid_services_enabled: false,
  });
  const sqlite = new DatabaseSync(join(root, 'core.sqlite'));
  try {
    sqlite.exec('PRAGMA foreign_keys=ON');
    for (const migration of ledger.migrations) {
      const sql = readFileSync('db/migrations/' + migration.name);
      if (digest(sql) !== migration.sha256)
        throw new Error('MIGRATION_HASH_MISMATCH');
      sqlite.exec(sql.toString('utf8'));
    }
    await restoreCanonical(
      sqliteAdapter(sqlite),
      JSON.parse(bytes.toString('utf8')),
      process.env.GOOGLE_OIDC_OWNER_SUBJECT!,
    );
    journal = {
      owner_id: String(
        sqlite.prepare('SELECT owner_id FROM owner_users').get()!.owner_id,
      ),
      credential_hash: await sha256(randomToken()),
      cursor_secret: randomToken(),
      connection_id: id,
      phase: 'SETUP',
      file_id: null,
      artifact_id: null,
      next_retry_at: null,
      started_at: new Date().toISOString(),
      source_id: '',
      pending_job_id: null,
      creates: 0,
    };
    journal.source_id = String(
      sqlite
        .prepare('SELECT source_id FROM sources WHERE owner_id=? LIMIT 1')
        .get(journal.owner_id)!.source_id,
    );
    sqlite
      .prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
      .run(
        id,
        journal.owner_id,
        journal.credential_hash,
        '["DRIVE_EXPORT"]',
        journal.started_at,
      );
    sqlite
      .prepare(
        'INSERT INTO owner_sessions(session_hash,owner_id,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?)',
      )
      .run(
        id,
        journal.owner_id,
        'local-fixture',
        journal.started_at,
        '2099-01-01T00:00:00Z',
      );
    sqlite
      .prepare('UPDATE export_state SET paused_reason=? WHERE owner_id=?')
      .run('ISOLATED_DRILL_EXCLUDED', journal.owner_id);
    sqlite
      .prepare(
        `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,root_id,root_state,revision,last_intent_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,'CONNECTED',?,'VERIFIED',1,?,?,?)`,
      )
      .run(
        journal.owner_id,
        id,
        'isolated-fixture',
        'isolated-fixture',
        '[]',
        canaryRoot,
        id,
        journal.started_at,
        journal.started_at,
      );
    writeFileSync(journalPath, JSON.stringify(journal), {
      flag: 'wx',
      mode: 0o600,
    });
  } finally {
    sqlite.close();
  }
} else {
  journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  const originalPrereg = join(output, 'preregistration.json');
  const repairedPrereg = join(output, 'preregistration-after-setup-fix.json');
  const prereg = JSON.parse(
    readFileSync(
      existsSync(repairedPrereg) ? repairedPrereg : originalPrereg,
      'utf8',
    ),
  );
  if (mode === '--continue-setup') {
    if (
      journal.phase !== 'SETUP' ||
      journal.creates !== 0 ||
      journal.file_id ||
      journal.artifact_id
    )
      throw new Error('UNSUBMITTED_SETUP_ONLY');
    save('preregistration-after-setup-fix.json', {
      ...prereg,
      pins,
      recorded_at: new Date().toISOString(),
      preceding_preregistration_sha256: digest(readFileSync(originalPrereg)),
      adjustment: 'CANONICAL_ISO_TIMESTAMP_FIXED_BEFORE_FAULT_INJECTION',
      remote_create_attempts_before_fix: 0,
    });
  }
  if (mode !== '--continue-setup') {
    if (JSON.stringify(prereg.pins) !== JSON.stringify(pins))
      throw new Error('DRILL_CANDIDATE_CHANGED');
    if (journal.phase !== 'WAITING_RETRY' || !journal.next_retry_at)
      throw new Error('RESUMABLE_DRIVE_CONSUMER_REQUIRED');
    if (Date.now() < Date.parse(journal.next_retry_at)) {
      console.log(
        JSON.stringify({
          state: 'WAITING_RETRY',
          id,
          not_before: journal.next_retry_at,
          provider_requests: 0,
        }),
      );
      process.exit(0);
    }
  }
}
const budget = d1TestBudget(queryBatch, {
  requests: 15,
  rows_read: 1000,
  rows_written: 10,
});
const remote = remoteDatabase(budget.execute);
const worker = await AccessContext.worker(
  remote,
  await sha256(process.env.DRIVE_EXPORT_WORKER_CREDENTIAL!),
);
worker.requireTask('DRIVE_EXPORT');
if (worker.ownerId !== journal.owner_id)
  throw new Error('DRILL_OWNER_MISMATCH');
const connection = await remote
  .prepare(
    "SELECT connection_id FROM drive_connections WHERE owner_id=? AND root_id=? AND auth_state='CONNECTED' AND root_state='VERIFIED' LIMIT 1",
  )
  .bind(worker.ownerId, canaryRoot)
  .first<string>('connection_id');
if (!connection) throw new Error('EXISTING_APPROVED_PRIVATE_DAILY_REQUIRED');
const grant = await refreshDriveAccess(
  remote,
  worker,
  {
    client_id: process.env.GOOGLE_DRIVE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET!,
    app_origin: process.env.APP_ORIGIN!,
  },
  await importDriveWrappingKey(
    process.env.DRIVE_WRAPPING_KEY_ID!,
    process.env.DRIVE_WRAPPING_KEY!,
  ),
  connection,
  new Date(),
);
let providerRequests = 0,
  interrupted = false;
const transport: typeof fetch = async (url, init) => {
  if (interrupted) return new Response(null, { status: 503 });
  const target = new URL(String(url));
  if (target.hostname !== 'www.googleapis.com' || init?.method === 'DELETE')
    throw new Error('DRILL_DRIVE_TRANSPORT_SCOPE_DENIED');
  const create = init?.method === 'POST';
  if (
    create &&
    (!['--start', '--continue-setup'].includes(mode!) || journal.creates !== 0)
  )
    throw new Error('DRILL_SECOND_CREATE_REFUSED');
  if (create) {
    journal.creates++;
    writeFileSync(journalPath, JSON.stringify(journal), { mode: 0o600 });
  }
  providerRequests++;
  const response = await fetch(url, init);
  if (create && response.ok) {
    await response.body?.cancel();
    interrupted = true;
    return new Response(null, { status: 503 });
  }
  return response;
};
const client = new DriveClient(grant.access_token, transport);
const create = client.createMarkdown.bind(client);
client.createMarkdown = (input) =>
  create({ ...input, name: 'BI-DIAGNOSTIC-RECOVERY-' + id + '.md' });
await client.verifyPrivateFolder(canaryRoot);
const sqlite = new DatabaseSync(join(root, 'core.sqlite'));
try {
  sqlite.exec('PRAGMA foreign_keys=ON');
  const db = sqliteAdapter(sqlite),
    owner = await AccessContext.owner(db, id, new Date().toISOString());
  const context = await AccessContext.worker(db, journal.credential_hash);
  const itemInput = (video: string) => ({
    namespace: 'youtube' as const,
    external_id: video,
    canonical_url: 'https://www.youtube.com/watch?v=' + video,
    item_type: 'video' as const,
    title: 'DIAGNOSTIC CANARY - synthetic pending item, no AI summary',
    published_at: date + 'T12:00:00.000Z',
    publication_provenance: 'SOURCE' as const,
    availability: 'PUBLIC' as const,
    duration_seconds: 60,
  });
  const snapshot = () =>
    sqlite
      .prepare(
        'SELECT * FROM export_state WHERE owner_id=? AND root_namespace=? AND publication_date=?',
      )
      .get(journal.owner_id, canaryRoot, date)!;
  const input = {
    app_origin: process.env.APP_ORIGIN!,
    cursor_secret: journal.cursor_secret,
    client: async () => client,
  };
  if (['--start', '--continue-setup'].includes(mode!)) {
    await new ItemRepository(db, owner).upsert(
      journal.source_id,
      itemInput('abcdefghijk'),
      new Date().toISOString(),
    );
    await new DriveExportIdentity(db, context).ensure(
      id,
      canaryRoot,
      date,
      new Date(Date.now() - 1801000),
    );
    const dirty = new ExportDirtyDays(db, context);
    for (let page = 0; page < 64; page++) {
      if (!(await dirty.sync(new Date())).more_possible) break;
      if (page === 63) throw new Error('ISOLATED_REPLAY_LIMIT');
    }
    const failed = await runDriveExportTick(db, context, input, new Date());
    const state = snapshot();
    if (
      failed.state !== 'RETRY_WAIT' ||
      !state.rendered_artifact_id ||
      !state.reserved_remote_id ||
      journal.creates !== 1
    )
      throw new Error('CONTROLLED_CONSUMER_FAILURE_NOT_PERSISTED');
    journal.artifact_id = String(state.rendered_artifact_id);
    journal.file_id = String(state.reserved_remote_id);
    journal.next_retry_at = String(state.next_retry_at);
    const late = (await new ItemRepository(db, owner).upsert(
      journal.source_id,
      itemInput('bcdefghijkl'),
      new Date().toISOString(),
    ))!;
    const job = await new JobStore(db, owner).enqueue(
      {
        item_id: late.item_id,
        source_id: journal.source_id,
        task_type: 'FETCH_TRANSCRIPT',
        input_revision: 'isolated-canary',
        profile_revision: 'economy-1',
        prompt_snapshot_id: null,
        routing_policy_version: 'local-primary-1',
        wire_schema_version: null,
        canonical_schema_version: null,
        enrichment_version: null,
        explicit_run_nonce: '',
        arrival_origin_at: new Date().toISOString(),
        origin_kind: 'MANUAL',
        payload: { diagnostic_canary: true },
        priority: 20,
        due_at: new Date().toISOString(),
      },
      new Date().toISOString(),
    );
    if (!job) throw new Error('ISOLATED_SOURCE_JOB_REQUIRED');
    journal.pending_job_id = job.job_id;
    const early = await runDriveExportTick(db, context, input, new Date());
    if (early.state !== 'IDLE') throw new Error('EARLY_RETRY_NOT_DEFERRED');
    journal.phase = 'WAITING_RETRY';
    writeFileSync(journalPath, JSON.stringify(journal), { mode: 0o600 });
    save('failure.json', {
      observed_at: new Date().toISOString(),
      state: failed.state,
      early: early.state,
      file_id: journal.file_id,
      artifact_id: journal.artifact_id,
      next_retry_at: journal.next_retry_at,
      pending_job_created: true,
      creates: journal.creates,
      provider_requests: providerRequests,
      production_d1: budget.usage,
      scope:
        'ACTUAL_PROVIDER_CREATE_CONTROLLED_CONSUMER_FAULT_ISOLATED_SQLITE_NO_AI_RESULT',
      gemini_requests: 0,
      paid_services_enabled: false,
    });
    console.log(
      JSON.stringify({
        state: 'WAITING_RETRY',
        id,
        next_retry_at: journal.next_retry_at,
        creates: 1,
        evidence: output,
      }),
    );
  } else {
    const before = snapshot();
    const recovered = await runDriveExportTick(db, context, input, new Date());
    const state = snapshot();
    const sealed = await new DailyExportArtifacts(db, context).read(
      journal.artifact_id!,
    );
    const remoteBefore = await client.getFile(journal.file_id!);
    const text = await client.readMarkdown(journal.file_id!, 8 * 1024 * 1024);
    const remoteAfter = await client.getFile(journal.file_id!);
    const pending = sqlite
      .prepare('SELECT state FROM jobs WHERE job_id=?')
      .get(journal.pending_job_id!);
    const observations = {
      recovered_state: recovered.state,
      process_restarted: true,
      same_sealed_artifact: state.rendered_artifact_id === journal.artifact_id,
      same_file_id: state.file_id === journal.file_id,
      creates: journal.creates,
      fence_advanced:
        Number(state.fencing_token) > Number(before.fencing_token),
      independent_byte_readback:
        text === new TextDecoder().decode(sealed.bytes),
      independent_hash: await sha256(text),
      sealed_hash: sealed.manifest.content_hash,
      stable_remote_version: remoteBefore.version === remoteAfter.version,
      late_change_retained:
        Number(state.dirty_seq) > Number(state.exported_seq),
      source_job_durable: pending?.state === 'PENDING',
      canonical_integrity:
        sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check ===
        'ok',
      foreign_keys:
        sqlite.prepare('PRAGMA foreign_key_check').all().length === 0,
    };
    const pass =
      recovered.state === 'VERIFIED' &&
      observations.same_sealed_artifact &&
      observations.same_file_id &&
      journal.creates === 1 &&
      observations.fence_advanced &&
      observations.independent_byte_readback &&
      observations.independent_hash === observations.sealed_hash &&
      observations.stable_remote_version &&
      observations.late_change_retained &&
      observations.source_job_durable &&
      observations.canonical_integrity &&
      observations.foreign_keys;
    save('receipt.json', {
      version: 'DriveConsumerProviderRecovery/1.0',
      observed_at: new Date().toISOString(),
      status: pass ? 'PASS' : 'FAIL',
      pins,
      scope:
        'ACTUAL_PROVIDER_CONSUMER_RECOVERY_ONLY_NOT_FULL_GATE_R_OR_P0_QUALITY',
      file_id: journal.file_id,
      root_id: canaryRoot,
      observations,
      recovery_elapsed_ms:
        Date.now() -
        Date.parse(
          JSON.parse(readFileSync(join(output, 'failure.json'), 'utf8'))
            .observed_at,
        ),
      full_drill_elapsed_ms: Date.now() - Date.parse(journal.started_at),
      logical_clock: false,
      actual_remote_create_controlled_response_loss: true,
      production_d1: budget.usage,
      provider_requests: providerRequests,
      production_delete: 0,
      gemini_requests: 0,
      paid_services_enabled: false,
    });
    if (!pass) throw new Error('DRIVE_CONSUMER_RECOVERY_ASSERTION_FAILED');
    journal.phase = 'VERIFIED';
    writeFileSync(journalPath, JSON.stringify(journal), { mode: 0o600 });
    console.log(
      JSON.stringify({
        state: 'PASS',
        id,
        scope: 'ACTUAL_PROVIDER_RECOVERY_ONLY',
        evidence: output,
        observations,
      }),
    );
  }
} finally {
  sqlite.close();
}
