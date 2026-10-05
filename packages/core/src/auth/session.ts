import { AccessContext } from '../db/boundary.js';
import type { Database } from '../db/boundary.js';
import { randomToken, sha256, sign, verifySigned } from './crypto.js';

export async function issueSession(
  db: Database,
  identity: { issuer: string; subject: string },
  secret: string,
  now: Date,
) {
  const owner = await db
    .prepare(
      'SELECT owner_id FROM owner_users WHERE issuer=? AND subject=? AND allowlisted=1',
    )
    .bind(identity.issuer, identity.subject)
    .first<{ owner_id: string }>();
  if (!owner) throw new Error('FORBIDDEN');
  const token = randomToken(),
    csrf = randomToken();
  const signature = await sign(token, secret);
  await db
    .prepare(
      'INSERT INTO owner_sessions(session_hash,owner_id,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?)',
    )
    .bind(
      await sha256(token),
      owner.owner_id,
      await sha256(csrf),
      now.toISOString(),
      new Date(now.getTime() + 28800000).toISOString(),
    )
    .run();
  return {
    csrf,
    cookie: `__Host-bi-session=${token}.${signature}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=28800`,
  };
}
export async function authenticateSession(
  db: Database,
  signed: string,
  secret: string,
  now: Date,
) {
  return AccessContext.owner(
    db,
    await sha256(await verifySigned(signed, secret)),
    now.toISOString(),
  );
}
export async function requireCsrf(
  db: Database,
  request: Request,
  signed: string,
  secret: string,
  origin: string,
  now: Date,
) {
  if (
    new URL(origin).origin !== origin ||
    request.headers.get('Origin') !== origin ||
    !origin.startsWith('https://')
  )
    throw new Error('CSRF_DENIED');
  const csrf = request.headers.get('X-CSRF-Token');
  if (!csrf || csrf.length > 128) throw new Error('CSRF_DENIED');
  const context = await authenticateSession(db, signed, secret, now);
  const row = await db
    .prepare(
      'SELECT session_hash FROM owner_sessions WHERE owner_id=? AND session_hash=? AND csrf_hash=? AND revoked_at IS NULL AND expires_at>?',
    )
    .bind(
      context.ownerId,
      await sha256(await verifySigned(signed, secret)),
      await sha256(csrf),
      now.toISOString(),
    )
    .first();
  if (!row) throw new Error('CSRF_DENIED');
  return context;
}
export async function revokeSession(
  db: Database,
  signed: string,
  secret: string,
  now: Date,
) {
  const context = await authenticateSession(db, signed, secret, now);
  await db
    .prepare(
      'UPDATE owner_sessions SET revoked_at=? WHERE owner_id=? AND session_hash=?',
    )
    .bind(
      now.toISOString(),
      context.ownerId,
      await sha256(await verifySigned(signed, secret)),
    )
    .run();
}
