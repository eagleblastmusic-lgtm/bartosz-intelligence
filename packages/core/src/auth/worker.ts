import { AccessContext } from '../db/boundary.js';
import type { Database } from '../db/boundary.js';
import { randomToken, sha256 } from './crypto.js';
export async function authenticateWorker(
  db: Database,
  request: Request,
  task: string,
) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
    request.headers.get('Authorization') ?? '',
  );
  if (!match) throw new Error('UNAUTHENTICATED');
  const context = await AccessContext.worker(db, await sha256(match[1]!));
  context.requireTask(task);
  return context;
}
export async function rotateWorker(
  db: Database,
  context: AccessContext,
  workerId: string,
  now: Date,
) {
  context.requireOwner();
  const token = randomToken();
  const result = await db
    .prepare(
      'UPDATE worker_identities SET credential_hash=?,revoked_at=NULL,created_at=? WHERE owner_id=? AND worker_id=?',
    )
    .bind(await sha256(token), now.toISOString(), context.ownerId, workerId)
    .run();
  if (result.meta.changes !== 1) throw new Error('NOT_FOUND');
  return token;
}
