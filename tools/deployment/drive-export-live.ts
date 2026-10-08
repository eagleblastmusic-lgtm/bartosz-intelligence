import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { remoteDatabase } from './cloudflare.mjs';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { randomToken, sha256 } from '../../packages/core/src/auth/crypto.js';
import { importDriveWrappingKey } from '../../packages/core/src/drive/credentials.js';
import {
  refreshDriveAccess,
  DriveOAuthFailure,
} from '../../packages/core/src/drive/oauth.js';
import {
  DriveClient,
  DriveFailure,
} from '../../packages/core/src/drive/client.js';
import {
  DriveExportIdentity,
  type ExportLease,
} from '../../packages/core/src/drive/identity.js';
import { renderOwnerDaily } from '../../packages/core/src/export/snapshot.js';
import { DailyExportArtifacts } from '../../packages/core/src/export/artifacts.js';
import { DailyExportExecutor } from '../../packages/core/src/export/executor.js';
import { ExportSettings } from '../../packages/core/src/export/settings.js';

// Explicit single-day verification using the production repositories. No cron,
// synthetic source changes, provider calls or automatic export activation.
const [, , flag, connectionId, rootId, date] = process.argv;
const requestedMode = process.argv[7];
if (
  (process.argv.length !== 6 &&
    !(
      process.argv.length === 8 &&
      process.argv[6] === '--mode' &&
      (requestedMode === 'COMPACT' || requestedMode === 'FULL')
    )) ||
  flag !== '--live' ||
  !/^[A-Za-z0-9_-]{1,128}$/.test(connectionId ?? '') ||
  !/^[A-Za-z0-9_-]{1,200}$/.test(rootId ?? '') ||
  !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')
)
  throw new Error('EXPLICIT_LIVE_DAY_REQUIRED');
const config = {
  client_id: process.env.GOOGLE_DRIVE_CLIENT_ID ?? '',
  client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? '',
  app_origin: process.env.APP_ORIGIN ?? '',
};
if (
  !config.client_id ||
  !config.client_secret ||
  !process.env.DRIVE_WRAPPING_KEY_ID ||
  !process.env.DRIVE_WRAPPING_KEY ||
  process.env.DRIVE_KEY_RECOVERY_READY !== 'true' ||
  (process.env.SESSION_SIGNING_SECRET?.length ?? 0) < 32
)
  throw new Error('LOCAL_DRIVE_CONFIGURATION_REQUIRED');
const db = remoteDatabase();
const owners = await db
  .prepare('SELECT owner_id FROM owner_users WHERE allowlisted=1 LIMIT 2')
  .all<{ owner_id: string }>();
if (owners.results.length !== 1) throw new Error('VERIFIED_OWNER_REQUIRED');
const ownerId = owners.results[0]!.owner_id;
const approved = await db
  .prepare(
    "SELECT 1 FROM drive_connections WHERE owner_id=? AND connection_id=? AND root_id=? AND root_state='VERIFIED' AND auth_state='CONNECTED'",
  )
  .bind(ownerId, connectionId!, rootId!)
  .first();
if (!approved) throw new Error('OWNER_APPROVED_ROOT_REQUIRED');
const now = new Date();
const sessionHash = await sha256(randomToken());
await db
  .prepare(
    'INSERT INTO owner_sessions(session_hash,owner_id,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?)',
  )
  .bind(
    sessionHash,
    ownerId,
    await sha256(randomToken()),
    now.toISOString(),
    new Date(now.getTime() + 900000).toISOString(),
  )
  .run();
let lease: ExportLease | undefined;
let identity: DriveExportIdentity | undefined;
let phase = 'REFRESH';
const receipt: Record<string, unknown> = {
  version: 'DriveLiveExport/1.0',
  trial_id: randomUUID(),
  publication_date: date,
  root_id: rootId,
  automatic_exports_enabled: false,
  paid_services_enabled: false,
  basis: 'ACTUAL_PROVIDER',
};
try {
  const context = await AccessContext.owner(db, sessionHash, now.toISOString());
  const wrapping = await importDriveWrappingKey(
    process.env.DRIVE_WRAPPING_KEY_ID!,
    process.env.DRIVE_WRAPPING_KEY!,
  );
  const grant = await refreshDriveAccess(
    db,
    context,
    config,
    wrapping,
    connectionId!,
    new Date(),
  );
  receipt.token_renewal_verified = true;
  const client = new DriveClient(grant.access_token);
  identity = new DriveExportIdentity(db, context);
  await identity.ensure(connectionId!, rootId!, date!, new Date());
  if (requestedMode === 'COMPACT' || requestedMode === 'FULL') {
    const revision = await db
      .prepare(
        "SELECT settings_revision FROM export_state WHERE owner_id=? AND root_namespace=? AND publication_date=? AND destination_key GLOB 'drive:*'",
      )
      .bind(ownerId, rootId!, date!)
      .first<number>('settings_revision');
    if (!revision) throw new Error('EXPORT_STATE_REQUIRED');
    await new ExportSettings(db, context).mode(
      rootId!,
      date!,
      requestedMode,
      revision,
      new Date(),
    );
    receipt.requested_mode = requestedMode;
  }
  phase = 'SNAPSHOT';
  lease = await identity.claim(
    rootId!,
    date!,
    'live-export-verifier',
    new Date(),
  );
  const state = await db
    .prepare(
      "SELECT revision,COALESCE(desired_mode,mode) mode FROM export_state WHERE owner_id=? AND root_namespace=? AND publication_date=? AND destination_key GLOB 'drive:*'",
    )
    .bind(ownerId, rootId!, date!)
    .first<{ revision: number; mode: 'COMPACT' | 'FULL' }>();
  const maximum = await db
    .prepare(
      'SELECT COALESCE(MAX(revision),0) n FROM daily_export_artifacts WHERE owner_id=? AND root_id=? AND publication_date=?',
    )
    .bind(ownerId, rootId!, date!)
    .first<number>('n');
  if (!state) throw new Error('EXPORT_STATE_REQUIRED');
  const report = await renderOwnerDaily(
    db,
    context,
    {
      date: date!,
      app_origin: config.app_origin,
      revision: Math.max(state.revision, maximum ?? 0) + 1,
      mode: state.mode,
    },
    process.env.SESSION_SIGNING_SECRET!,
    new Date(),
  );
  const artifactId = await new DailyExportArtifacts(db, context).save(
    lease,
    report,
    new Date(),
  );
  phase = 'EXPORT';
  const exported = await new DailyExportExecutor(db, context).execute(
    lease,
    artifactId,
    client,
    new Date(),
  );
  phase = 'READBACK';
  const contentHash = await sha256(
    await client.readMarkdown(exported.file_id, 8 * 1024 * 1024),
  );
  if (contentHash !== exported.content_hash)
    throw new Error('EXPORT_READBACK_MISMATCH');
  Object.assign(receipt, {
    status: 'PASS',
    artifact_id: artifactId,
    ...exported,
    independent_readback_verified: true,
  });
} catch (error) {
  Object.assign(receipt, {
    status: 'FAIL',
    phase,
    reason:
      error instanceof DriveFailure
        ? error.category
        : error instanceof DriveOAuthFailure
          ? error.reason
          : error instanceof Error &&
              [
                'READ_SNAPSHOT_CHANGED',
                'EXPORT_READBACK_MISMATCH',
                'EXPORT_CONFLICT',
                'EXPORT_STALE_FENCE_OR_REVISION',
              ].includes(error.message)
            ? error.message
            : 'LOCAL_OR_TRANSPORT_FAILURE',
  });
} finally {
  if (identity && lease) await identity.release(lease);
  await db
    .prepare('UPDATE owner_sessions SET revoked_at=? WHERE session_hash=?')
    .bind(new Date().toISOString(), sessionHash)
    .run();
}
receipt.sampled_at = new Date().toISOString();
mkdirSync('docs/verification/drive', { recursive: true });
const path = `docs/verification/drive/${receipt.trial_id}.json`;
writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(
  JSON.stringify({
    status: receipt.status,
    phase: receipt.phase ?? 'COMPLETE',
    reason: receipt.reason ?? null,
    evidence: path,
  }),
);
if (receipt.status !== 'PASS') process.exitCode = 2;
