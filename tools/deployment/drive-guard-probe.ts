import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { remoteDatabase } from './cloudflare.mjs';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { randomToken, sha256 } from '../../packages/core/src/auth/crypto.js';
import {
  DriveClient,
  DriveFailure,
} from '../../packages/core/src/drive/client.js';
import { importDriveWrappingKey } from '../../packages/core/src/drive/credentials.js';
import {
  refreshDriveAccess,
  DriveOAuthFailure,
} from '../../packages/core/src/drive/oauth.js';

// Explicit qualification only. Never enables the production update adapter.
const [, , mode, connectionId, rootId] = process.argv;
if (
  mode !== '--live' ||
  !connectionId ||
  !rootId ||
  process.argv.length !== 5 ||
  !/^[A-Za-z0-9_-]{1,128}$/.test(connectionId) ||
  !/^[A-Za-z0-9_-]{1,128}$/.test(rootId)
)
  throw new Error('EXPLICIT_LIVE_CONNECTION_AND_ROOT_REQUIRED');
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
  process.env.DRIVE_KEY_RECOVERY_READY !== 'true'
)
  throw new Error('LOCAL_DRIVE_CONFIGURATION_REQUIRED');
const db = remoteDatabase();
const owners = await db
  .prepare('SELECT owner_id FROM owner_users WHERE allowlisted=1 LIMIT 2')
  .all<{ owner_id: string }>();
if (owners.results.length !== 1) throw new Error('VERIFIED_OWNER_REQUIRED');
const ownerId = owners.results[0]!.owner_id;
const allowed = await db
  .prepare(
    `SELECT 1 FROM drive_root_candidates r JOIN drive_connections c USING(owner_id,connection_id)
  WHERE r.owner_id=? AND r.connection_id=? AND r.reserved_folder_id=? AND r.state='CREATED' AND c.auth_state='CONNECTED'`,
  )
  .bind(ownerId, connectionId, rootId)
  .first();
if (!allowed) throw new Error('CONNECTED_APP_CREATED_ROOT_REQUIRED');
const sessionHash = await sha256(randomToken());
const now = new Date();
await db
  .prepare(
    'INSERT INTO owner_sessions(session_hash,owner_id,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?)',
  )
  .bind(
    sessionHash,
    ownerId,
    await sha256(randomToken()),
    now.toISOString(),
    new Date(now.getTime() + 300000).toISOString(),
  )
  .run();
let intentId: string | undefined;
let phase = 'REFRESH';
const trialId = randomUUID();
let receipt: Record<string, unknown>;
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
    connectionId,
    new Date(),
  );
  const client = new DriveClient(grant.access_token);
  phase = 'INTENT';
  const reservedId = await client.reserveId();
  const nonce = await sha256(randomToken());
  const scopeHash = await sha256(JSON.stringify([connectionId, rootId]));
  intentId = 'drive-guard-probe:' + scopeHash + ':' + trialId;
  const payload = JSON.stringify({
    version: 'drive-guard-probe-intent:1',
    connection_id: connectionId,
    root_id: rootId,
    reserved_id: reservedId,
    nonce,
    method: 'V3_MEDIA_PATCH_IF_MATCH',
    maximum_trials: 3,
    automatic_updates_enabled: false,
  });
  const inserted = await db
    .prepare(
      `INSERT INTO config_versions(config_id,owner_id,revision,payload_json,content_hash,created_at)
    SELECT ?,?,1,?,?,? WHERE (SELECT count(*) FROM config_versions WHERE owner_id=? AND config_id LIKE ? AND revision=1)<3`,
    )
    .bind(
      intentId,
      ownerId,
      payload,
      await sha256(payload),
      new Date().toISOString(),
      ownerId,
      'drive-guard-probe:' + scopeHash + ':%',
    )
    .run();
  if (inserted.meta.changes !== 1)
    throw new Error('BOUNDED_TRIAL_BUDGET_EXHAUSTED');
  phase = 'PROBE';
  const proof = await client.probeMarkdownGuard({
    reserved_id: reservedId,
    root_id: rootId,
    nonce,
  });
  receipt = { status: 'PASS', trial_id: trialId, phase, ...proof };
} catch (error) {
  receipt = {
    status: 'FAIL',
    trial_id: trialId,
    phase,
    reason:
      error instanceof DriveFailure
        ? error.category
        : error instanceof DriveOAuthFailure
          ? error.reason
          : 'LOCAL_OR_TRANSPORT_FAILURE',
    http_status: error instanceof DriveFailure ? error.http_status : null,
    automatic_updates_enabled: false,
  };
} finally {
  await db
    .prepare('UPDATE owner_sessions SET revoked_at=? WHERE session_hash=?')
    .bind(new Date().toISOString(), sessionHash)
    .run();
}
const sampledAt = new Date().toISOString();
receipt.sampled_at = sampledAt;
const json = JSON.stringify(receipt, null, 2) + '\n';
if (intentId)
  await db
    .prepare('INSERT INTO config_versions VALUES(?,?,2,?,?,?)')
    .bind(intentId, ownerId, json, await sha256(json), sampledAt)
    .run();
mkdirSync('docs/verification/drive', { recursive: true });
writeFileSync('docs/verification/drive/' + trialId + '.json', json, {
  flag: 'wx',
});
console.log(json);
if (receipt.status !== 'PASS') process.exitCode = 1;
