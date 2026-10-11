import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { candidatePins } from '../../release/pins.js';
import { sqliteAdapter } from '../../db/sqlite-adapter.js';
import { requirePrivateRecoveryDirectory } from '../../db/private-directory.js';
import { queryBatch, remoteDatabase } from '../../deployment/cloudflare.mjs';
import { d1TestBudget } from '../../deployment/d1-test-budget.js';
import { d1UsagePolicy } from '../../deployment/d1-usage-policy.js';
import { AccessContext } from '../../../packages/core/src/db/boundary.js';
import { sha256 } from '../../../packages/core/src/auth/crypto.js';
import { importDriveWrappingKey } from '../../../packages/core/src/drive/credentials.js';
import { refreshDriveAccess } from '../../../packages/core/src/drive/oauth.js';
import { DriveClient } from '../../../packages/core/src/drive/client.js';
import { runDriveExportTick } from '../../../packages/core/src/export/runtime.js';
import { DailyExportArtifacts } from '../../../packages/core/src/export/artifacts.js';
import { ExportDirtyDays } from '../../../packages/core/src/export/dirty.js';
import defaults from '../../../config/defaults.json';
const args = process.argv.slice(2);
if (
  args.length !== 2 ||
  !['--verified-canary', '--verify-idle'].includes(args[0]!) ||
  !/^[a-f0-9-]{36}$/.test(args[1]!)
)
  throw new Error('EXPLICIT_VERIFIED_CANARY_REQUIRED');
if (defaults.paid_services_enabled !== false)
  throw new Error('PAID_POLICY_DENIED');
if (
  !d1UsagePolicy(
    JSON.parse(readFileSync('.local/d1-usage/latest.json', 'utf8')),
    new Date(),
  ).noncritical_admitted
)
  throw new Error('FRESH_D1_ANALYTICS_REQUIRED');
const id = args[1]!,
  privateRoot = resolve('.local/drive-consumer-recovery', id);
requirePrivateRecoveryDirectory(privateRoot);
const output = resolve(
  'docs/verification/gate-r/provider-drive-consumer-' + id,
);
const priorPath = join(output, 'receipt.json'),
  prior = JSON.parse(readFileSync(priorPath, 'utf8'));
const journal = JSON.parse(
  readFileSync(join(privateRoot, 'journal.json'), 'utf8'),
) as {
  owner_id: string;
  credential_hash: string;
  cursor_secret: string;
  file_id: string;
  phase: string;
  artifact_id: string;
  creates: number;
  pending_job_id: string;
};
if (
  prior.status !== 'PASS' ||
  journal.phase !== 'VERIFIED' ||
  journal.file_id !== prior.file_id ||
  journal.creates !== 1
)
  throw new Error('VERIFIED_DIAGNOSTIC_CANARY_REQUIRED');
const verifyOnly = args[0] === '--verify-idle';
const preregPath = join(
  output,
  verifyOnly
    ? 'late-revision-idle-recovery-preregistration.json'
    : 'late-revision-preregistration.json',
);
if (existsSync(preregPath)) throw new Error('LATE_REVISION_ALREADY_ATTEMPTED');
const pins = candidatePins(),
  digest = (value: Uint8Array) =>
    createHash('sha256').update(value).digest('hex');
const previous = verifyOnly
  ? JSON.parse(readFileSync(join(output, 'late-revision-receipt.json'), 'utf8'))
  : null;
if (
  verifyOnly &&
  (previous.status !== 'FAIL' ||
    previous.file_id !== journal.file_id ||
    previous.observations.state !== 'VERIFIED' ||
    !previous.observations.same_file_id ||
    previous.observations.updates !== 1 ||
    previous.observations.new_revision <= previous.observations.old_revision ||
    !previous.observations.byte_readback ||
    !previous.observations.hash_readback ||
    !previous.observations.late_change_acknowledged)
)
  throw new Error('ALREADY_VERIFIED_UPDATE_WITH_FAILED_IDLE_CHECK_REQUIRED');
writeFileSync(
  preregPath,
  JSON.stringify(
    {
      recorded_at: new Date().toISOString(),
      pins,
      predecessor_receipt_sha256: digest(readFileSync(priorPath)),
      case_id: 'same_file_late_revision',
      file_id: journal.file_id,
      maximum_canary_updates: verifyOnly ? 0 : 1,
      maximum_create_attempts: 0,
      scope:
        'ACTUAL_DRIVE_PROTOCOL_WITH_ISOLATED_PENDING_ITEM_FIXTURES_NOT_AI_QUALITY',
      existing_user_reports_modified: false,
      gemini_requests: 0,
      paid_services_enabled: false,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
const rootId = '1rn_5auxY_8HAeADc1RgGKQ6h9JimD7WM',
  date = '2000-01-01';
const budget = d1TestBudget(queryBatch, {
    requests: 15,
    rows_read: 1000,
    rows_written: 10,
  }),
  remote = remoteDatabase(budget.execute);
const worker = await AccessContext.worker(
  remote,
  await sha256(process.env.DRIVE_EXPORT_WORKER_CREDENTIAL!),
);
worker.requireTask('DRIVE_EXPORT');
if (worker.ownerId !== journal.owner_id)
  throw new Error('CANARY_OWNER_MISMATCH');
const connection = await remote
  .prepare(
    "SELECT connection_id FROM drive_connections WHERE owner_id=? AND root_id=? AND auth_state='CONNECTED' AND root_state='VERIFIED' LIMIT 1",
  )
  .bind(worker.ownerId, rootId)
  .first<string>('connection_id');
if (!connection) throw new Error('APPROVED_EXISTING_DAILY_REQUIRED');
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
let updates = 0,
  providerRequests = 0;
const client = new DriveClient(grant.access_token, async (url, options) => {
  const target = new URL(String(url));
  if (
    target.hostname !== 'www.googleapis.com' ||
    options?.method === 'POST' ||
    options?.method === 'DELETE'
  )
    throw new Error('CANARY_CREATE_DELETE_REFUSED');
  if (options?.method === 'PUT') {
    if (verifyOnly) throw new Error('IDLE_VERIFICATION_WRITE_REFUSED');
    if (!target.pathname.endsWith('/' + journal.file_id) || updates !== 0)
      throw new Error('CANARY_UPDATE_SCOPE_REFUSED');
    updates++;
  }
  providerRequests++;
  return fetch(url, options);
});
await client.verifyPrivateFolder(rootId);
await client.verifyPrivateFolder(journal.file_id);
const metadata = await client.getFile(journal.file_id);
if (
  !metadata.name.startsWith('BI-DIAGNOSTIC-RECOVERY-' + id) ||
  !metadata.parents?.includes(rootId) ||
  metadata.trashed !== false
)
  throw new Error('UNRELATED_REPORT_REFUSED');
const oldText = await client.readMarkdown(journal.file_id, 8 * 1024 * 1024);
const sqlite = new DatabaseSync(join(privateRoot, 'core.sqlite'));
try {
  sqlite.exec('PRAGMA foreign_keys=ON');
  const db = sqliteAdapter(sqlite),
    context = await AccessContext.worker(db, journal.credential_hash);
  const state = () =>
    sqlite
      .prepare(
        'SELECT * FROM export_state WHERE owner_id=? AND root_namespace=? AND publication_date=?',
      )
      .get(journal.owner_id, rootId, date)!;
  const before = state();
  // Restored days may be recreated by dirty replay. Flush it first and pause
  // every unrelated isolated destination; never let the canary try their files.
  const dirty = new ExportDirtyDays(db, context);
  for (let page = 0; page < 64; page++) {
    if (!(await dirty.sync(new Date())).more_possible) break;
    if (page === 63) throw new Error('ISOLATED_REPLAY_LIMIT');
  }
  await db
    .prepare(
      "UPDATE export_state SET paused_reason='ISOLATED_DRILL_EXCLUDED' WHERE owner_id=? AND (root_namespace!=? OR publication_date!=?)",
    )
    .bind(journal.owner_id, rootId, date)
    .run();
  if (verifyOnly) {
    const repeated = await runDriveExportTick(
      db,
      context,
      {
        app_origin: process.env.APP_ORIGIN!,
        cursor_secret: journal.cursor_secret,
        client: async () => client,
      },
      new Date(),
    );
    const after = state(),
      sealed = await new DailyExportArtifacts(db, context).read(
        String(after.rendered_artifact_id),
      );
    const a = await client.getFile(journal.file_id),
      text = await client.readMarkdown(journal.file_id, 8 * 1024 * 1024),
      b = await client.getFile(journal.file_id);
    const observations = {
      repeated_state: repeated.state,
      updates,
      creates: 0,
      same_file_id: after.file_id === journal.file_id,
      revision_unchanged: after.revision === before.revision,
      byte_readback: text === new TextDecoder().decode(sealed.bytes),
      hash_readback: (await sha256(text)) === sealed.manifest.content_hash,
      stable_version: a.version === b.version,
      late_change_acknowledged:
        Number(after.exported_seq) >= Number(after.dirty_seq),
      source_job_durable:
        sqlite
          .prepare('SELECT state FROM jobs WHERE job_id=?')
          .get(journal.pending_job_id)?.state === 'PENDING',
    };
    const pass =
      repeated.state === 'IDLE' &&
      updates === 0 &&
      observations.same_file_id &&
      observations.revision_unchanged &&
      observations.byte_readback &&
      observations.hash_readback &&
      observations.stable_version &&
      observations.late_change_acknowledged &&
      observations.source_job_durable;
    writeFileSync(
      join(output, 'late-revision-idle-recovery-receipt.json'),
      JSON.stringify(
        {
          recorded_at: new Date().toISOString(),
          pins,
          status: pass ? 'PASS' : 'FAIL',
          scope:
            'CANARY_SCOPED_POST_UPDATE_RECOVERY_VERIFICATION_NOT_FULL_D_EXPORT',
          file_id: journal.file_id,
          previous_receipt_sha256: digest(
            readFileSync(join(output, 'late-revision-receipt.json')),
          ),
          original_update_properties: previous.observations,
          observations,
          production_d1: budget.usage,
          provider_requests: providerRequests,
          production_delete: 0,
          gemini_requests: 0,
          paid_services_enabled: false,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    if (!pass) throw new Error('CANARY_SCOPED_IDLE_NOT_VERIFIED');
    console.log(
      JSON.stringify({ status: 'PASS', evidence: output, observations }),
    );
    process.exitCode = 0;
  } else {
    if (
      before.file_id !== journal.file_id ||
      Number(before.dirty_seq) <= Number(before.exported_seq)
    )
      throw new Error('PERSISTED_LATE_CHANGE_REQUIRED');
    const result = await runDriveExportTick(
      db,
      context,
      {
        app_origin: process.env.APP_ORIGIN!,
        cursor_secret: journal.cursor_secret,
        client: async () => client,
      },
      new Date(),
    );
    const after = state(),
      sealed = await new DailyExportArtifacts(db, context).read(
        String(after.rendered_artifact_id),
      );
    const a = await client.getFile(journal.file_id),
      text = await client.readMarkdown(journal.file_id, 8 * 1024 * 1024),
      b = await client.getFile(journal.file_id);
    const repeated = await runDriveExportTick(
      db,
      context,
      {
        app_origin: process.env.APP_ORIGIN!,
        cursor_secret: journal.cursor_secret,
        client: async () => client,
      },
      new Date(),
    );
    const observations = {
      state: result.state,
      same_file_id: after.file_id === before.file_id,
      old_revision: Number(before.revision),
      new_revision: Number(after.revision),
      updates,
      creates: 0,
      changed_hash: (await sha256(oldText)) !== (await sha256(text)),
      byte_readback: text === new TextDecoder().decode(sealed.bytes),
      hash_readback: (await sha256(text)) === sealed.manifest.content_hash,
      stable_version: a.version === b.version,
      late_change_acknowledged:
        Number(after.exported_seq) >= Number(after.dirty_seq),
      repeated_state: repeated.state,
      source_job_durable:
        sqlite
          .prepare('SELECT state FROM jobs WHERE job_id=?')
          .get(journal.pending_job_id)?.state === 'PENDING',
      integrity:
        sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check ===
        'ok',
      foreign_keys:
        sqlite.prepare('PRAGMA foreign_key_check').all().length === 0,
    };
    const pass =
      result.state === 'VERIFIED' &&
      observations.same_file_id &&
      observations.new_revision > observations.old_revision &&
      updates === 1 &&
      observations.changed_hash &&
      observations.byte_readback &&
      observations.hash_readback &&
      observations.stable_version &&
      observations.late_change_acknowledged &&
      repeated.state === 'IDLE' &&
      observations.source_job_durable &&
      observations.integrity &&
      observations.foreign_keys;
    writeFileSync(
      join(output, 'late-revision-receipt.json'),
      JSON.stringify(
        {
          recorded_at: new Date().toISOString(),
          pins,
          status: pass ? 'PASS' : 'FAIL',
          scope:
            'ACTUAL_DRIVE_SAME_FILE_LATE_REVISION_ONLY_NOT_FULL_D_EXPORT_OR_P0',
          file_id: journal.file_id,
          observations,
          production_d1: budget.usage,
          provider_requests: providerRequests,
          production_delete: 0,
          gemini_requests: 0,
          paid_services_enabled: false,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    if (!pass) throw new Error('CANARY_LATE_REVISION_ASSERTION_FAILED');
    console.log(
      JSON.stringify({
        status: 'PASS',
        scope: 'ACTUAL_PROTOCOL_ONLY',
        evidence: output,
        observations,
      }),
    );
  }
} finally {
  sqlite.close();
}
