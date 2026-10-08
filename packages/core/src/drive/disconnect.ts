import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';

/** Explicit owner action; preserves Core and file mapping, removes local grant. */
export async function disconnectDrive(
  db: Database,
  context: AccessContext,
  input: { connection_id: string; expected_revision: number },
  now: Date,
) {
  assertContext(context);
  context.requireOwner();
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.connection_id) ||
    !Number.isSafeInteger(input.expected_revision) ||
    input.expected_revision < 1 ||
    !Number.isFinite(now.getTime())
  )
    throw new Error('INVALID_EXPORT_SETTINGS');
  const receipt = crypto.randomUUID();
  const result = await db.batch([
    db
      .prepare(
        `UPDATE drive_connections SET auth_state='REVOKED',root_state=CASE WHEN root_id IS NULL THEN 'UNSELECTED' ELSE 'VERIFY_REQUIRED' END,revision=revision+1,last_intent_hash=?,updated_at=?,last_error=NULL WHERE owner_id=? AND connection_id=? AND revision=? AND auth_state!='REVOKED'`,
      )
      .bind(
        receipt,
        now.toISOString(),
        context.ownerId,
        input.connection_id,
        input.expected_revision,
      ),
    db
      .prepare(
        `DELETE FROM drive_credentials WHERE owner_id=? AND connection_id=? AND EXISTS(SELECT 1 FROM drive_connections c WHERE c.owner_id=drive_credentials.owner_id AND c.connection_id=drive_credentials.connection_id AND c.last_intent_hash=? AND c.auth_state='REVOKED')`,
      )
      .bind(context.ownerId, input.connection_id, receipt),
    db
      .prepare(
        `UPDATE drive_oauth_intents SET consumed_at=? WHERE owner_id=? AND connection_id=? AND consumed_at IS NULL AND EXISTS(SELECT 1 FROM drive_connections c WHERE c.owner_id=drive_oauth_intents.owner_id AND c.connection_id=drive_oauth_intents.connection_id AND c.last_intent_hash=? AND c.auth_state='REVOKED')`,
      )
      .bind(now.toISOString(), context.ownerId, input.connection_id, receipt),
    db
      .prepare(
        `UPDATE export_state SET lease_owner=NULL,lease_until=NULL,fencing_token=fencing_token+1 WHERE owner_id=? AND connection_id=? AND EXISTS(SELECT 1 FROM drive_connections c WHERE c.owner_id=export_state.owner_id AND c.connection_id=export_state.connection_id AND c.last_intent_hash=? AND c.auth_state='REVOKED')`,
      )
      .bind(context.ownerId, input.connection_id, receipt),
  ]);
  if (result[0]?.meta.changes !== 1) throw new Error('REVISION_CONFLICT');
  return {
    auth_state: 'REVOKED' as const,
    revision: input.expected_revision + 1,
    mapping_action: 'PRESERVE_EXISTING' as const,
    local_credential_removed: true as const,
    google_account_grant_revoked: false as const,
  };
}
