import type { Database } from '../db/boundary.js';
import { beginLogin } from './oidc.js';
import type { OidcConfig } from './oidc.js';
import { sha256 } from './crypto.js';
export async function beginOwnerBootstrap(
  db: Database,
  config: OidcConfig,
  capability: string,
  now: Date,
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error('FORBIDDEN');
  const hash = await sha256(capability),
    at = now.toISOString();
  const grant = await db
    .prepare(
      `SELECT grant_hash FROM owner_bootstrap_grants WHERE grant_hash=? AND expires_at>? AND state_hash IS NULL AND consumed_at IS NULL AND NOT EXISTS(SELECT 1 FROM owner_users WHERE allowlisted=1)`,
    )
    .bind(hash, at)
    .first();
  if (!grant) throw new Error('FORBIDDEN');
  const intent = await beginLogin(
    db,
    { ...config, ownerSubject: '' },
    now,
    'BOOTSTRAP',
  );
  const stateHash = await sha256(
    new URL(intent.url).searchParams.get('state')!,
  );
  const bound = await db
    .prepare(
      `UPDATE owner_bootstrap_grants SET state_hash=? WHERE grant_hash=? AND expires_at>? AND state_hash IS NULL AND consumed_at IS NULL AND NOT EXISTS(SELECT 1 FROM owner_users WHERE allowlisted=1)`,
    )
    .bind(stateHash, hash, at)
    .run();
  if (bound.meta.changes !== 1) throw new Error('FORBIDDEN');
  return intent;
}
export async function bootstrapState(db: Database, state: string, now: Date) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return false;
  return Boolean(
    await db
      .prepare(
        `SELECT g.grant_hash FROM owner_bootstrap_grants g JOIN oidc_login_intents i USING(state_hash) WHERE g.state_hash=? AND g.expires_at>? AND g.consumed_at IS NULL AND i.purpose='BOOTSTRAP' AND i.consumed_at IS NULL AND i.expires_at>? AND NOT EXISTS(SELECT 1 FROM owner_users WHERE allowlisted=1)`,
      )
      .bind(await sha256(state), now.toISOString(), now.toISOString())
      .first(),
  );
}
// Only call with the identity produced by finishLogin's signed Google token verifier.
export async function claimBootstrapOwner(
  db: Database,
  state: string,
  identity: { issuer: string; subject: string },
  now: Date,
) {
  if (
    identity.issuer !== 'https://accounts.google.com' ||
    !identity.subject ||
    identity.subject.length > 256
  )
    throw new Error('FORBIDDEN');
  const stateHash = await sha256(state),
    ownerId = crypto.randomUUID(),
    at = now.toISOString();
  const result = await db.batch([
    db
      .prepare(
        `INSERT INTO owner_users(owner_id,issuer,subject,allowlisted,created_at) SELECT ?,?,?,1,? WHERE NOT EXISTS(SELECT 1 FROM owner_users WHERE allowlisted=1) AND EXISTS(SELECT 1 FROM owner_bootstrap_grants g JOIN oidc_login_intents i USING(state_hash) WHERE g.state_hash=? AND g.expires_at>? AND g.consumed_at IS NULL AND i.purpose='BOOTSTRAP' AND i.consumed_at IS NOT NULL AND i.expires_at>?)`,
      )
      .bind(ownerId, identity.issuer, identity.subject, at, stateHash, at, at),
    db
      .prepare(
        `UPDATE owner_bootstrap_grants SET consumed_at=? WHERE state_hash=? AND consumed_at IS NULL AND EXISTS(SELECT 1 FROM owner_users WHERE owner_id=?)`,
      )
      .bind(at, stateHash, ownerId),
    db
      .prepare(
        `INSERT INTO audit_events(event_id,owner_id,actor_id,event_type,target_id,correlation_id,created_at) SELECT ?,owner_id,owner_id,'OWNER_BOOTSTRAPPED',owner_id,?,? FROM owner_users WHERE owner_id=?`,
      )
      .bind(crypto.randomUUID(), crypto.randomUUID(), at, ownerId),
  ]);
  if (result[0]?.meta.changes !== 1 || result[1]?.meta.changes !== 1)
    throw new Error('FORBIDDEN');
}
