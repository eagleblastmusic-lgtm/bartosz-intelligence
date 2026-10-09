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
import { verifyReservedCreateRecovery } from './drive-create-recovery.js';
import defaults from '../../config/defaults.json' with { type: 'json' };

if (defaults.paid_services_enabled !== false)
  throw new Error('PAID_POLICY_DENIED');

const [, , mode, connectionId, rootId] = process.argv;
if (
  process.argv.length !== 5 ||
  mode !== '--live' ||
  !/^[A-Za-z0-9_-]{1,128}$/.test(connectionId ?? '') ||
  !/^[A-Za-z0-9_-]{1,200}$/.test(rootId ?? '')
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
if (
  !(await db
    .prepare(
      "SELECT 1 FROM drive_connections WHERE owner_id=? AND connection_id=? AND root_id=? AND root_state='VERIFIED' AND auth_state='CONNECTED'",
    )
    .bind(ownerId, connectionId!, rootId!)
    .first())
)
  throw new Error('OWNER_APPROVED_ROOT_REQUIRED');
const trialId = randomUUID(),
  sessionHash = await sha256(randomToken()),
  now = new Date();
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
let receipt: Record<string, unknown>;
let phase = 'REFRESH';
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
  const client = new DriveClient(grant.access_token);
  await client.verifyPrivateFolder(rootId!);
  phase = 'PREREGISTRATION';
  const prefix =
    'drive-create-recovery:' +
    (await sha256(JSON.stringify([connectionId, rootId]))) +
    ':';
  // Check before reserving an ID; one create trial per approved scope.
  if (
    await db
      .prepare(
        'SELECT 1 FROM config_versions WHERE owner_id=? AND substr(config_id,1,length(?))=? AND revision=1',
      )
      .bind(ownerId, prefix, prefix)
      .first()
  )
    throw new Error('BOUNDED_TRIAL_BUDGET_EXHAUSTED');
  const reservedId = await client.reserveId();
  const proposed = prefix + trialId;
  const intent = JSON.stringify({
    version: 'DriveCreateRecoveryIntent/1.0',
    trial_id: trialId,
    connection_id: connectionId,
    root_id: rootId,
    reserved_id: reservedId,
    maximum_create_attempts: 1,
    injection: 'DISCARD_SUCCESS_RESPONSE',
    expected: 'INDEPENDENT_HASH_READBACK_SAME_RESERVED_ID_NO_SECOND_CREATE',
    automatic_exports_enabled: false,
    paid_services_enabled: false,
  });
  const inserted = await db
    .prepare(
      'INSERT INTO config_versions SELECT ?,?,1,?,?,? WHERE NOT EXISTS(SELECT 1 FROM config_versions WHERE owner_id=? AND substr(config_id,1,length(?))=? AND revision=1)',
    )
    .bind(
      proposed,
      ownerId,
      intent,
      await sha256(intent),
      new Date().toISOString(),
      ownerId,
      prefix,
      prefix,
    )
    .run();
  if (inserted.meta.changes !== 1)
    throw new Error('BOUNDED_TRIAL_BUDGET_EXHAUSTED');
  intentId = proposed;
  phase = 'ACTUAL_CREATE_AND_RECOVERY';
  const proof = await verifyReservedCreateRecovery(grant.access_token, {
    reserved_id: reservedId,
    root_id: rootId!,
    trial_id: trialId,
  });
  const stored = await db
    .prepare(
      'SELECT content_hash,payload_json FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
    )
    .bind(ownerId, intentId)
    .first<{ content_hash: string; payload_json: string }>();
  if (
    !stored ||
    stored.content_hash !== (await sha256(stored.payload_json)) ||
    JSON.parse(stored.payload_json).reserved_id !== proof.file_id
  )
    throw new Error('CREATE_PROBE_DURABLE_IDENTITY_MISMATCH');
  receipt = {
    status: 'PASS',
    ...proof,
    durable_reserved_identity_verified: true,
    token_renewal_verified: true,
  };
} catch (error) {
  receipt = {
    status: 'FAIL',
    phase,
    reason:
      error instanceof DriveFailure
        ? error.category
        : error instanceof DriveOAuthFailure
          ? error.reason
          : error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
            ? error.message
            : 'LOCAL_OR_TRANSPORT_FAILURE',
    http_status: error instanceof DriveFailure ? error.http_status : null,
  };
} finally {
  await db
    .prepare('UPDATE owner_sessions SET revoked_at=? WHERE session_hash=?')
    .bind(new Date().toISOString(), sessionHash)
    .run();
}
Object.assign(receipt, {
  version: 'DriveCreateRecoveryProbe/1.0',
  trial_id: trialId,
  observed_at: new Date().toISOString(),
  basis: 'ACTUAL_PROVIDER_WITH_INJECTED_RESPONSE_LOSS',
  automatic_exports_enabled: false,
  paid_services_enabled: false,
  secret_values_recorded: false,
  full_d_export_qualified: false,
  scope:
    'Reserved create/client recovery and independent readback. Separate verification file, not a Daily export or full outage drill.',
});
const json = JSON.stringify(receipt, null, 2) + '\n';
if (intentId)
  await db
    .prepare('INSERT INTO config_versions VALUES(?,?,2,?,?,?)')
    .bind(intentId, ownerId, json, await sha256(json), new Date().toISOString())
    .run();
mkdirSync('docs/verification/drive', { recursive: true });
writeFileSync('docs/verification/drive/' + trialId + '.json', json, {
  flag: 'wx',
});
console.log(json);
if (receipt.status !== 'PASS') process.exitCode = 1;
