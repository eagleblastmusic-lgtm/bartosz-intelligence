import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
import { leasePredicate } from '../jobs/lease-guard.js';
import type { LeaseToken } from '../../../contracts/src/jobs.js';

// Internal Core completion for deterministically verified diagnostic candidates.
// No canonical Ledger, active selection or accepted-run effects are produced.
export async function finalizeCandidateRun(
  db: Database,
  context: AccessContext,
  token: LeaseToken,
  runId: string,
  value: Record<string, unknown>,
  reason:
    | 'QUALITY_TEST_COMPLETE'
    | 'CHUNK_CANDIDATE_COMPLETE'
    | 'OPTIONAL_PARTIAL_COMPLETE'
    | 'OPTIONAL_INVALID_COMPLETE',
  now: Date,
  task: 'ANALYZE' | 'TRANSLATE' | 'HISTORICAL_COMPARE' = 'ANALYZE',
) {
  assertContext(context);
  const invalid = reason === 'OPTIONAL_INVALID_COMPLETE';
  const guard = leasePredicate(context, token, now.toISOString(), task),
    outcome = JSON.stringify(value),
    hash = await sha256(outcome),
    nonce = crypto.randomUUID();
  const active = `${guard.predicate} AND EXISTS(SELECT 1 FROM job_attempts WHERE owner_id=? AND job_id=? AND fencing_token=? AND commit_nonce=?)`;
  const bindings = [
    ...guard.bindings,
    context.ownerId,
    token.job_id,
    token.fencing_token,
    nonce,
  ];
  const result = await db.batch([
    db
      .prepare(
        `UPDATE job_attempts SET commit_nonce=?,candidate_hash=?,finished_at=? WHERE owner_id=? AND job_id=? AND fencing_token=? AND commit_nonce IS NULL AND ${guard.predicate} AND EXISTS(SELECT 1 FROM analysis_runs WHERE owner_id=? AND run_id=? AND job_id=? AND state='CANDIDATE' AND candidate_hash IS NULL)`,
      )
      .bind(
        nonce,
        hash,
        now.toISOString(),
        context.ownerId,
        token.job_id,
        token.fencing_token,
        ...guard.bindings,
        context.ownerId,
        runId,
        token.job_id,
      ),
    db
      .prepare(
        `UPDATE analysis_runs SET candidate_hash=?,outcome_json=?,validation_outcome=? WHERE owner_id=? AND job_id=? AND run_id=? AND state='CANDIDATE' AND ${active}`,
      )
      .bind(
        hash,
        outcome,
        invalid ? 'DETERMINISTIC_CORE_INVALID' : 'DETERMINISTIC_CORE_CANDIDATE',
        context.ownerId,
        token.job_id,
        runId,
        ...bindings,
      ),
    db
      .prepare(
        `UPDATE jobs SET state=?,reason_code=?,result_candidate_id=?,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE owner_id=? AND job_id=? AND state='RUNNING' AND ${active} RETURNING job_id`,
      )
      .bind(
        invalid ? 'FAILED' : 'SUCCEEDED',
        reason,
        runId,
        now.toISOString(),
        context.ownerId,
        token.job_id,
        ...bindings,
      ),
  ]);
  if (
    result[0]?.meta.changes !== 1 ||
    result[1]?.meta.changes !== 1 ||
    result[2]?.results?.length !== 1
  )
    throw new Error('STALE_FENCE');
  return {
    accepted: false,
    run_id: runId,
    state: invalid ? 'FAILED' : 'SUCCEEDED',
    candidate_status: invalid ? 'INVALID' : 'VALIDATED',
  };
}
