import { AccessContext, assertContext, type Database } from '../db/boundary.js';
import { SearchIndex } from './search-index.js';
import { JobStore } from '../jobs/store.js';
import { leasePredicate } from '../jobs/lease-guard.js';

/** Complete one existing projection intent; never enqueue another projection. */
export async function completeProjectionJob(
  db: Database,
  access: AccessContext,
  now: Date,
) {
  assertContext(access);
  access.requireTask('PROJECT');
  (await AccessContext.worker(db, access.credentialHash!)).requireTask(
    'PROJECT',
  );
  const metadata = await new SearchIndex(db, access).metadata();
  if (metadata.freshness !== 'FRESH') return { completed: false };
  const job = await db
    .prepare(
      `SELECT j.job_id,j.input_revision FROM jobs j JOIN analysis_runs r ON r.owner_id=j.owner_id AND r.run_id=j.input_revision JOIN jobs source ON source.owner_id=r.owner_id AND source.job_id=r.job_id WHERE j.owner_id=? AND j.task_type='PROJECT' AND j.state='PENDING' AND j.due_at<=? AND j.routing_policy_version='control-plane-1' AND j.profile_revision='projection-1' AND json_extract(j.payload_json,'$.run_id')=r.run_id AND r.state='ACCEPTED' AND source.state='SUCCEEDED' ORDER BY j.arrival_origin_at,j.job_id LIMIT 1`,
    )
    .bind(access.ownerId, now.toISOString())
    .first<{ job_id: string; input_revision: string }>();
  if (!job) return { completed: false };
  const store = new JobStore(db, access);
  const lease = await store.lease(job.job_id, 'PROJECT', now, 'local');
  if (!lease) return { completed: false };
  await store.start(lease, 'PROJECT', now);
  const guard = leasePredicate(access, lease, now.toISOString(), 'PROJECT');
  const proof = `EXISTS(SELECT 1 FROM search_index_state WHERE owner_id=? AND phase='COMPLETE' AND indexed_cut>=?) AND NOT EXISTS(SELECT 1 FROM change_log WHERE owner_id=? AND seq>? AND component NOT IN ('jobs','discovery')) AND EXISTS(SELECT 1 FROM analysis_runs r JOIN jobs source ON source.owner_id=r.owner_id AND source.job_id=r.job_id WHERE r.owner_id=? AND r.run_id=? AND r.state='ACCEPTED' AND source.state='SUCCEEDED')`;
  const bindings = [
    access.ownerId,
    metadata.cut_seq,
    access.ownerId,
    metadata.cut_seq,
    access.ownerId,
    job.input_revision,
  ];
  const nonce = crypto.randomUUID();
  const result = await db.batch([
    db
      .prepare(
        `UPDATE job_attempts SET finished_at=?,commit_nonce=? WHERE owner_id=? AND job_id=? AND fencing_token=? AND ${guard.predicate} AND ${proof}`,
      )
      .bind(
        now.toISOString(),
        nonce,
        access.ownerId,
        job.job_id,
        lease.fencing_token,
        ...guard.bindings,
        ...bindings,
      ),
    db
      .prepare(
        `UPDATE jobs SET state='SUCCEEDED',result_candidate_id=?,reason_code=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE owner_id=? AND job_id=? AND ${guard.predicate} AND ${proof} AND EXISTS(SELECT 1 FROM job_attempts WHERE owner_id=? AND job_id=? AND fencing_token=? AND commit_nonce=?)`,
      )
      .bind(
        job.input_revision,
        now.toISOString(),
        access.ownerId,
        job.job_id,
        ...guard.bindings,
        ...bindings,
        access.ownerId,
        job.job_id,
        lease.fencing_token,
        nonce,
      ),
  ]);
  return { completed: result[1]?.meta.changes === 1 };
}
