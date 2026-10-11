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
import { DriveExportIdentity } from '../../../packages/core/src/drive/identity.js';
import { DailyExportArtifacts } from '../../../packages/core/src/export/artifacts.js';
import { DailyExportExecutor } from '../../../packages/core/src/export/executor.js';
import { renderOwnerDaily } from '../../../packages/core/src/export/snapshot.js';
import { ItemRepository } from '../../../packages/core/src/db/items.js';
import type { ItemMetadata } from '../../../packages/contracts/src/discovery.js';
import defaults from '../../../config/defaults.json';
const args = process.argv.slice(2);
if (
  args.length !== 2 ||
  !['--verified-canary', '--resume-conflict'].includes(args[0]!) ||
  !/^[a-f0-9-]{36}$/.test(args[1]!)
)
  throw new Error('EXPLICIT_CANARY_CONFLICT_REQUIRED');
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
  resume = args[0] === '--resume-conflict',
  privateRoot = resolve('.local/drive-consumer-recovery', id),
  output = resolve('docs/verification/gate-r/provider-drive-consumer-' + id);
requirePrivateRecoveryDirectory(privateRoot);
const journal = JSON.parse(
  readFileSync(join(privateRoot, 'journal.json'), 'utf8'),
) as {
  owner_id: string;
  credential_hash: string;
  cursor_secret: string;
  file_id: string;
  source_id: string;
  pending_job_id: string;
  phase: string;
};
const predecessor = join(output, 'late-revision-idle-recovery-receipt.json');
if (
  journal.phase !== 'VERIFIED' ||
  JSON.parse(readFileSync(predecessor, 'utf8')).status !== 'PASS'
)
  throw new Error('VERIFIED_LATE_REVISION_REQUIRED');
const failedPath = join(output, 'manual-conflict-receipt.json');
const previous = resume ? JSON.parse(readFileSync(failedPath, 'utf8')) : null;
if (
  resume &&
  (previous?.status !== 'FAIL' ||
    previous.observations?.reason !== 'EXPORT_STALE_FENCE_OR_REVISION' ||
    previous.file_id !== journal.file_id ||
    previous.observations?.explicit_canary_puts !== 1 ||
    previous.observations?.consumer_write_attempts !== 0)
)
  throw new Error('RETAINED_FIXTURE_MODE_FAILURE_REQUIRED');
const prereg = join(
  output,
  resume
    ? 'manual-conflict-recovery-preregistration.json'
    : 'manual-conflict-preregistration.json',
);
if (existsSync(prereg)) throw new Error('CANARY_CONFLICT_ALREADY_ATTEMPTED');
const pins = candidatePins();
writeFileSync(
  prereg,
  JSON.stringify(
    {
      recorded_at: new Date().toISOString(),
      pins,
      predecessor_sha256: createHash('sha256')
        .update(readFileSync(predecessor))
        .digest('hex'),
      file_id: journal.file_id,
      case_id: 'manual_edit_conflict',
      injection: resume
        ? 'REUSE_ALREADY_APPENDED_CANARY_WITH_CORRECT_FIXTURE_MODE'
        : 'APPEND_COMMENT_PRESERVE_EVERY_EXISTING_REPORT_BYTE',
      predecessor_failure_sha256: resume
        ? createHash('sha256').update(readFileSync(failedPath)).digest('hex')
        : null,
      maximum_explicit_canary_puts: resume ? 0 : 1,
      maximum_consumer_puts: 0,
      maximum_creates: 0,
      scope:
        'ACTUAL_CANARY_MANUAL_CONFLICT_WITH_ISOLATED_CANONICAL_FIXTURES_NOT_HUMAN_QUALITY',
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
let explicitPuts = 0,
  consumerWrites = 0,
  providerRequests = 0;
const scopedTransport =
  (allowAppend: boolean): typeof fetch =>
  async (url, options) => {
    const target = new URL(String(url));
    if (
      target.hostname !== 'www.googleapis.com' ||
      options?.method === 'POST' ||
      options?.method === 'DELETE'
    )
      throw new Error('CANARY_CREATE_DELETE_REFUSED');
    if (options?.method === 'PUT') {
      if (!allowAppend) {
        consumerWrites++;
        throw new Error('CANARY_AUTOMATIC_OVERWRITE_REFUSED');
      }
      if (
        !target.pathname.endsWith('/' + journal.file_id) ||
        explicitPuts !== 0
      )
        throw new Error('CANARY_APPEND_SCOPE_REFUSED');
      explicitPuts++;
    }
    providerRequests++;
    return fetch(url, options);
  };
const writer = new DriveClient(grant.access_token, scopedTransport(true)),
  consumer = new DriveClient(grant.access_token, scopedTransport(false));
await writer.verifyPrivateFolder(rootId);
await writer.verifyPrivateFolder(journal.file_id);
const metadata = await writer.getFile(journal.file_id);
if (
  !metadata.name.startsWith('BI-DIAGNOSTIC-RECOVERY-' + id) ||
  metadata.trashed !== false ||
  !metadata.parents?.includes(rootId) ||
  !metadata.appProperties
)
  throw new Error('UNRELATED_REPORT_REFUSED');
const remoteBefore = await writer.readMarkdown(
  journal.file_id,
  8 * 1024 * 1024,
);
const original = resume
    ? readFileSync(join(privateRoot, 'before-manual-edit.md'), 'utf8')
    : remoteBefore,
  manual = original + '\n<!-- OWNER_EDIT_DIAGNOSTIC_CANARY ' + id + ' -->\n';
if (
  resume &&
  (remoteBefore !== manual ||
    (await sha256(manual)) !== previous.manual_sha256 ||
    (await sha256(original)) !== previous.original_sha256)
)
  throw new Error('PREVIOUS_CANARY_BYTES_CHANGED');
if (!resume) {
  writeFileSync(join(privateRoot, 'before-manual-edit.md'), original, {
    flag: 'wx',
    mode: 0o600,
  });
  await writer.updateMarkdown({
    id: journal.file_id,
    root_id: rootId,
    app_properties: metadata.appProperties,
    expected_hash: await sha256(original),
    markdown: manual,
    before_write: async () => {},
  });
}
const sqlite = new DatabaseSync(join(privateRoot, 'core.sqlite'));
try {
  sqlite.exec('PRAGMA foreign_keys=ON');
  const db = sqliteAdapter(sqlite),
    owner = await AccessContext.owner(db, id, new Date().toISOString()),
    context = await AccessContext.worker(db, journal.credential_hash);
  const old = sqlite
    .prepare(
      'SELECT m.metadata_json FROM items i JOIN item_revisions m ON m.owner_id=i.owner_id AND m.revision_id=i.current_revision_id WHERE i.owner_id=? AND i.external_id=?',
    )
    .get(journal.owner_id, 'abcdefghijk')!;
  const item = JSON.parse(String(old.metadata_json)) as ItemMetadata;
  if (!resume)
    await new ItemRepository(db, owner).upsert(
      journal.source_id,
      { ...item, title: item.title + ' - later conflict-test revision' },
      new Date().toISOString(),
    );
  const identity = new DriveExportIdentity(db, context);
  const state = sqlite
    .prepare(
      'SELECT revision,COALESCE(desired_mode,mode) mode,lease_owner,lease_until,fencing_token FROM export_state WHERE owner_id=? AND root_namespace=? AND publication_date=?',
    )
    .get(journal.owner_id, rootId, date)!;
  const lease =
    resume &&
    state.lease_owner === context.actorId &&
    Date.parse(String(state.lease_until)) > Date.now()
      ? {
          root_id: rootId,
          date,
          lease_owner: context.actorId,
          lease_until: String(state.lease_until),
          fencing_token: Number(state.fencing_token),
        }
      : await identity.claim(rootId, date, context.actorId, new Date());
  const highest = sqlite
    .prepare(
      'SELECT MAX(revision) revision FROM daily_export_artifacts WHERE owner_id=? AND root_id=? AND publication_date=?',
    )
    .get(journal.owner_id, rootId, date);
  if (state.mode !== 'COMPACT' && state.mode !== 'FULL')
    throw new Error('INVALID_FIXTURE_EXPORT_MODE');
  const report = await renderOwnerDaily(
    db,
    context,
    {
      date,
      app_origin: process.env.APP_ORIGIN!,
      revision:
        Math.max(Number(state.revision), Number(highest?.revision ?? 0)) + 1,
      mode: state.mode,
    },
    journal.cursor_secret,
    new Date(),
  );
  const artifact = await new DailyExportArtifacts(db, context).save(
    lease,
    report,
    new Date(),
  );
  let reason: string | null = null;
  try {
    await new DailyExportExecutor(db, context).execute(
      lease,
      artifact,
      consumer,
      new Date(),
    );
  } catch (error) {
    reason =
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'UNEXPECTED_CONFLICT_FAILURE';
  }
  const attempt = sqlite
    .prepare(
      'SELECT state,reason FROM drive_export_attempts WHERE owner_id=? AND artifact_id=?',
    )
    .get(journal.owner_id, artifact);
  const after = await consumer.readMarkdown(journal.file_id, 8 * 1024 * 1024);
  const observations = {
    reason,
    conflict_visible: attempt?.state === 'CONFLICT',
    manual_preserved: after === manual,
    original_bytes_preserved: after.startsWith(original),
    explicit_canary_puts: explicitPuts,
    consumer_write_attempts: consumerWrites,
    creates: 0,
    source_job_durable:
      sqlite
        .prepare('SELECT state FROM jobs WHERE job_id=?')
        .get(journal.pending_job_id)?.state === 'PENDING',
    integrity:
      sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok',
    foreign_keys: sqlite.prepare('PRAGMA foreign_key_check').all().length === 0,
  };
  const pass =
    reason === 'EXPORT_CONFLICT' &&
    observations.conflict_visible &&
    observations.manual_preserved &&
    observations.original_bytes_preserved &&
    explicitPuts === (resume ? 0 : 1) &&
    consumerWrites === 0 &&
    observations.source_job_durable &&
    observations.integrity &&
    observations.foreign_keys;
  writeFileSync(
    join(
      output,
      resume
        ? 'manual-conflict-recovery-receipt.json'
        : 'manual-conflict-receipt.json',
    ),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        pins,
        predecessor_failure_sha256: resume
          ? createHash('sha256').update(readFileSync(failedPath)).digest('hex')
          : null,
        status: pass ? 'PASS' : 'FAIL',
        scope: 'ACTUAL_CANARY_CONFLICT_ONLY_NOT_FULL_D_EXPORT_OR_HUMAN_QUALITY',
        file_id: journal.file_id,
        original_sha256: await sha256(original),
        manual_sha256: await sha256(manual),
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
  if (!pass) throw new Error('CANARY_MANUAL_CONFLICT_ASSERTION_FAILED');
  console.log(
    JSON.stringify({ status: 'PASS', evidence: output, observations }),
  );
} finally {
  sqlite.close();
}
