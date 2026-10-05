import type { AccessContext } from '../db/boundary.js';
import type { LeaseToken, TaskType } from '../../../contracts/src/jobs.js';
export function leasePredicate(
  context: AccessContext,
  token: LeaseToken,
  now: string,
  task: TaskType,
) {
  context.requireTask(task);
  if (token.lease_owner !== context.actorId) throw new Error('STALE_FENCE');
  return {
    predicate: `EXISTS(SELECT 1 FROM jobs j JOIN worker_identities w ON w.owner_id=j.owner_id AND w.worker_id=j.lease_owner WHERE j.owner_id=? AND j.job_id=? AND j.task_type=? AND j.state='RUNNING' AND j.lease_owner=? AND j.fencing_token=? AND j.lease_until>? AND w.revoked_at IS NULL AND w.credential_hash=?)`,
    bindings: [
      context.ownerId,
      token.job_id,
      task,
      context.actorId,
      token.fencing_token,
      now,
      context.credentialHash!,
    ] as const,
  };
}
