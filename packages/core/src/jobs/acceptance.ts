import type { LeaseToken, TaskType } from '../../../contracts/src/jobs.js';
import type { AccessContext, Database, Statement } from '../db/boundary.js';
import { assertContext } from '../db/boundary.js';
import { jobDedup } from './policy.js';
import { sha256 } from '../auth/crypto.js';
export class RunRepository {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async prepare(runId: string, jobId: string, now: string) {
    const result = await this.db
      .prepare(
        `INSERT INTO analysis_runs(run_id,owner_id,item_id,job_id,input_snapshot_json,profile_snapshot_json,prompt_snapshot_json,wire_schema_version,canonical_schema_version,enrichment_version,routing_snapshot_json,state,created_at)
      SELECT ?,owner_id,item_id,job_id,json_object('input_revision',input_revision),json_object('profile_revision',profile_revision),CASE WHEN prompt_snapshot_id IS NULL THEN NULL ELSE json_object('snapshot_id',prompt_snapshot_id) END,wire_schema_version,canonical_schema_version,enrichment_version,json_object('routing_policy_version',routing_policy_version),'CANDIDATE',? FROM jobs WHERE owner_id=? AND job_id=?
      ON CONFLICT(run_id) DO NOTHING`,
      )
      .bind(runId, now, this.context.ownerId, jobId)
      .run();
    return result.meta.changes === 1;
  }
  async requestSelection(runId: string, itemId: string) {
    this.context.requireOwner();
    const result = await this.db
      .prepare(
        `INSERT INTO active_analysis_selections(owner_id,item_id,requested_run_id,selection_revision)
      SELECT owner_id,item_id,run_id,1 FROM analysis_runs WHERE owner_id=? AND item_id=? AND run_id=?
      ON CONFLICT(owner_id,item_id) DO UPDATE SET requested_run_id=excluded.requested_run_id,selection_revision=selection_revision+1
      RETURNING selection_revision`,
      )
      .bind(this.context.ownerId, itemId, runId)
      .first<{ selection_revision: number }>();
    if (!result) throw new Error('NOT_FOUND');
    return result.selection_revision;
  }
  async complete(
    token: LeaseToken,
    task: TaskType,
    runId: string,
    candidateHash: string,
    outcome: Record<string, unknown>,
    selectionRevision: number | null,
    now: Date,
    effects?: (
      guard: string,
      bindings: readonly (string | number | null)[],
    ) => Statement[],
  ) {
    this.context.requireTask(task);
    if (
      token.lease_owner !== this.context.actorId ||
      !/^[a-f0-9]{64}$/.test(candidateHash) ||
      (await sha256(JSON.stringify(outcome))) !== candidateHash
    )
      throw new Error('INVALID_COMPLETION');
    const commitAt = now.toISOString(),
      nonce = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const projectDedup = await jobDedup(this.context.ownerId, {
      item_id: null,
      source_id: null,
      task_type: 'PROJECT',
      input_revision: runId,
      profile_revision: 'projection-1',
      prompt_snapshot_id: null,
      routing_policy_version: 'control-plane-1',
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: commitAt,
      origin_kind: 'INTEGRITY',
      payload: { run_id: runId },
      priority: 100,
      due_at: commitAt,
    });
    const guard = `EXISTS(SELECT 1 FROM job_attempts a JOIN jobs j ON j.owner_id=a.owner_id AND j.job_id=a.job_id
      JOIN worker_identities w ON w.owner_id=j.owner_id AND w.worker_id=j.lease_owner
      WHERE a.owner_id=? AND a.job_id=? AND a.fencing_token=? AND a.commit_nonce=?
      AND j.state='RUNNING' AND j.lease_owner=? AND j.fencing_token=? AND j.lease_until>?
      AND w.revoked_at IS NULL AND w.credential_hash=?)`;
    const bindings = [
      this.context.ownerId,
      token.job_id,
      token.fencing_token,
      nonce,
      this.context.actorId,
      token.fencing_token,
      commitAt,
      this.context.credentialHash!,
    ] as const;
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE job_attempts SET commit_nonce=?,candidate_hash=? WHERE owner_id=? AND job_id=? AND fencing_token=? AND commit_nonce IS NULL
        AND EXISTS(SELECT 1 FROM jobs j JOIN worker_identities w ON w.owner_id=j.owner_id AND w.worker_id=j.lease_owner
        WHERE j.owner_id=? AND j.job_id=? AND j.task_type=? AND j.state='RUNNING' AND j.lease_owner=? AND j.fencing_token=? AND j.lease_until>?
        AND w.revoked_at IS NULL AND w.credential_hash=?)
        AND EXISTS(SELECT 1 FROM analysis_runs WHERE owner_id=? AND job_id=? AND run_id=? AND state='CANDIDATE')`,
        )
        .bind(
          nonce,
          candidateHash,
          this.context.ownerId,
          token.job_id,
          token.fencing_token,
          this.context.ownerId,
          token.job_id,
          task,
          this.context.actorId,
          token.fencing_token,
          commitAt,
          this.context.credentialHash!,
          this.context.ownerId,
          token.job_id,
          runId,
        ),
      this.db
        .prepare(
          `UPDATE analysis_runs SET state='ACCEPTED',candidate_hash=?,validation_outcome='DETERMINISTIC_CORE_PROOF',outcome_json=?,accepted_at=? WHERE owner_id=? AND job_id=? AND run_id=? AND state='CANDIDATE' AND ${guard}`,
        )
        .bind(
          candidateHash,
          JSON.stringify(outcome),
          commitAt,
          this.context.ownerId,
          token.job_id,
          runId,
          ...bindings,
        ),
      ...(effects?.(guard, bindings) ?? []),
      this.db
        .prepare(
          `UPDATE active_analysis_selections SET accepted_run_id=? WHERE owner_id=? AND requested_run_id=? AND selection_revision=? AND ${guard}`,
        )
        .bind(
          runId,
          this.context.ownerId,
          runId,
          selectionRevision,
          ...bindings,
        ),
      this.db
        .prepare(
          `INSERT INTO jobs(job_id,owner_id,item_id,source_id,task_type,input_revision,profile_revision,prompt_snapshot_id,routing_policy_version,explicit_run_nonce,dedup_key,state,due_at,priority,arrival_origin_at,origin_kind,payload_json,created_at,updated_at)
        SELECT ?,owner_id,NULL,NULL,'PROJECT',?,'projection-1',NULL,'control-plane-1','',?,'PENDING',?,100,?,'INTEGRITY',?,?,? FROM jobs WHERE owner_id=? AND job_id=? AND ${guard}
        ON CONFLICT(owner_id,dedup_key) DO NOTHING`,
        )
        .bind(
          projectId,
          runId,
          projectDedup,
          commitAt,
          commitAt,
          JSON.stringify({ run_id: runId }),
          commitAt,
          commitAt,
          this.context.ownerId,
          token.job_id,
          ...bindings,
        ),
      this.db
        .prepare(
          `INSERT INTO outbox(event_id,owner_id,event_key,job_id,payload_json,due_at)
        SELECT ?,owner_id,'accepted:'||?,job_id,json_object('job_id',job_id,'fencing_hint',NULL,'task_type','PROJECT'),? FROM jobs WHERE owner_id=? AND dedup_key=? AND ${guard}
        ON CONFLICT(owner_id,event_key) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          runId,
          commitAt,
          this.context.ownerId,
          projectDedup,
          ...bindings,
        ),
      this.db
        .prepare(
          `UPDATE job_attempts SET finished_at=? WHERE owner_id=? AND job_id=? AND fencing_token=? AND ${guard}`,
        )
        .bind(
          commitAt,
          this.context.ownerId,
          token.job_id,
          token.fencing_token,
          ...bindings,
        ),
      this.db
        .prepare(
          `UPDATE jobs SET state='SUCCEEDED',result_candidate_id=?,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE owner_id=? AND job_id=? AND ${guard}`,
        )
        .bind(runId, commitAt, this.context.ownerId, token.job_id, ...bindings),
    ]);
    if (
      results[0]?.meta.changes === 1 &&
      results[1]?.meta.changes === 1 &&
      results.at(-1)?.meta.changes === 1
    )
      return {
        accepted: true,
        active: results[results.length - 5]?.meta.changes === 1,
        duplicate: false,
      };
    if (results.some((r) => r.meta.changes !== 0))
      throw new Error('ACCEPTANCE_INVARIANT_FAILED');
    const existing = await this.db
      .prepare(
        `SELECT r.run_id FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.job_id=? AND r.run_id=? AND r.candidate_hash=? AND r.state='ACCEPTED' AND j.state='SUCCEEDED'`,
      )
      .bind(this.context.ownerId, token.job_id, runId, candidateHash)
      .first();
    if (existing) return { accepted: true, active: false, duplicate: true };
    throw new Error('STALE_FENCE');
  }
}
