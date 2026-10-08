import type {
  JobInput,
  JobRecord,
  JobState,
  LeaseToken,
  TaskType,
} from '../../../contracts/src/jobs.js';
import { taskTypes } from '../../../contracts/src/jobs.js';
import { assertContext } from '../db/boundary.js';
import type { AccessContext, Database, Statement } from '../db/boundary.js';
import { jobDedup, runtimeAdmissionPredicate } from './policy.js';
export class JobStore {
  constructor(
    readonly db: Database,
    readonly context: AccessContext,
  ) {
    assertContext(context);
  }
  async prepareEnqueue(
    input: JobInput,
    now: string,
    precondition?: {
      predicate: string;
      bindings: readonly (string | number | null)[];
    },
  ): Promise<{ statements: Statement[]; dedup_key: string }> {
    if (
      !taskTypes.includes(input.task_type) ||
      !Number.isFinite(Date.parse(input.due_at)) ||
      !Number.isFinite(Date.parse(input.arrival_origin_at))
    )
      throw new Error('INVALID_JOB');
    const dedup = await jobDedup(this.context.ownerId, input);
    return {
      dedup_key: dedup,
      statements: [
        this.db
          .prepare(
            `INSERT INTO jobs(job_id,owner_id,item_id,source_id,task_type,input_revision,profile_revision,prompt_snapshot_id,routing_policy_version,wire_schema_version,canonical_schema_version,enrichment_version,explicit_run_nonce,dedup_key,state,due_at,priority,arrival_origin_at,origin_kind,payload_json,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING',?,?,?,?,?,?,? WHERE ${precondition?.predicate ?? '1'} ON CONFLICT(owner_id,dedup_key) DO NOTHING`,
          )
          .bind(
            crypto.randomUUID(),
            this.context.ownerId,
            input.item_id,
            input.source_id,
            input.task_type,
            input.input_revision,
            input.profile_revision,
            input.prompt_snapshot_id,
            input.routing_policy_version,
            input.wire_schema_version,
            input.canonical_schema_version,
            input.enrichment_version,
            input.explicit_run_nonce,
            dedup,
            input.due_at,
            input.priority,
            input.arrival_origin_at,
            input.origin_kind,
            JSON.stringify(input.payload),
            now,
            now,
            ...(precondition?.bindings ?? []),
          ),
        this.db
          .prepare(
            `INSERT INTO outbox(event_id,owner_id,event_key,job_id,payload_json,due_at)
        SELECT ?,owner_id,'job:'||job_id||':0',job_id,json_object('job_id',job_id,'fencing_hint',NULL,'task_type',task_type),due_at
        FROM jobs WHERE owner_id=? AND dedup_key=? AND task_type NOT IN ('DISCOVER','RECONCILE') AND ${precondition?.predicate ?? '1'} ON CONFLICT(owner_id,event_key) DO NOTHING`,
          )
          .bind(
            crypto.randomUUID(),
            this.context.ownerId,
            dedup,
            ...(precondition?.bindings ?? []),
          ),
      ],
    };
  }
  async enqueue(
    input: JobInput,
    now: string,
    precondition?: Parameters<JobStore['prepareEnqueue']>[2],
  ) {
    const prepared = await this.prepareEnqueue(input, now, precondition);
    await this.db.batch(prepared.statements);
    return this.db
      .prepare('SELECT * FROM jobs WHERE owner_id=? AND dedup_key=?')
      .bind(this.context.ownerId, prepared.dedup_key)
      .first<JobRecord>();
  }
  async get(jobId: string) {
    return this.db
      .prepare('SELECT * FROM jobs WHERE owner_id=? AND job_id=?')
      .bind(this.context.ownerId, jobId)
      .first<JobRecord>();
  }
  async replay(jobId: string, now: string, correlation: string) {
    this.context.requireOwner();
    const nonce = crypto.randomUUID();
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO audit_events(event_id,owner_id,actor_id,event_type,target_id,correlation_id,created_at)
        SELECT ?,owner_id,?,'JOB_REPLAY',job_id,?,? FROM jobs WHERE owner_id=? AND job_id=? AND state='FAILED' AND COALESCE(reason_code,'')<>'PROFILE_SUPERSEDED'`,
        )
        .bind(
          nonce,
          this.context.actorId,
          correlation,
          now,
          this.context.ownerId,
          jobId,
        ),
      this.db
        .prepare(
          `UPDATE jobs SET state='PENDING',reason_code=NULL,due_at=?,updated_at=?,lease_owner=NULL,lease_until=NULL
        WHERE owner_id=? AND job_id=? AND state='FAILED' AND COALESCE(reason_code,'')<>'PROFILE_SUPERSEDED' AND EXISTS(SELECT 1 FROM audit_events WHERE event_id=?) RETURNING job_id`,
        )
        .bind(now, now, this.context.ownerId, jobId, nonce),
    ]);
    if (results[1]?.results?.length !== 1) throw new Error('REPLAY_DENIED');
  }
  async lease(
    jobId: string,
    task: TaskType,
    now: Date,
    runtime: 'local' | 'cloud',
  ): Promise<LeaseToken | null> {
    this.context.requireTask(task);
    const until = new Date(
      now.getTime() + (runtime === 'local' ? 900000 : 300000),
    ).toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE jobs SET state='LEASED',lease_owner=?,lease_until=?,fencing_token=fencing_token+1,attempt_count=attempt_count+1,updated_at=?
        WHERE owner_id=? AND job_id=? AND task_type=? AND state='PENDING' AND due_at<=?
        AND ${runtimeAdmissionPredicate}
        AND EXISTS(SELECT 1 FROM worker_identities w WHERE w.owner_id=jobs.owner_id AND w.worker_id=? AND w.revoked_at IS NULL AND w.credential_hash=?) RETURNING job_id`,
        )
        .bind(
          this.context.actorId,
          until,
          now.toISOString(),
          this.context.ownerId,
          jobId,
          task,
          now.toISOString(),
          runtime,
          runtime,
          this.context.actorId,
          this.context.credentialHash!,
        ),
      this.db
        .prepare(
          `INSERT INTO job_attempts(attempt_id,owner_id,job_id,fencing_token,executor_id,started_at)
        SELECT ?,owner_id,job_id,fencing_token,lease_owner,? FROM jobs WHERE owner_id=? AND job_id=? AND state='LEASED' AND lease_owner=? AND lease_until=?
        ON CONFLICT(owner_id,job_id,fencing_token) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          now.toISOString(),
          this.context.ownerId,
          jobId,
          this.context.actorId,
          until,
        ),
    ]);
    if (results[0]?.results?.length !== 1) return null;
    const job = (await this.get(jobId))!;
    return {
      job_id: jobId,
      lease_owner: this.context.actorId,
      fencing_token: job.fencing_token,
      lease_until: until,
    };
  }
  async start(token: LeaseToken, task: TaskType, now: Date) {
    this.context.requireTask(task);
    if (token.lease_owner !== this.context.actorId)
      throw new Error('STALE_FENCE');
    const result = await this.db
      .prepare(
        `UPDATE jobs SET state='RUNNING',updated_at=? WHERE owner_id=? AND job_id=? AND task_type=? AND state='LEASED' AND lease_owner=? AND fencing_token=? AND lease_until>?
      AND EXISTS(SELECT 1 FROM worker_identities WHERE owner_id=? AND worker_id=? AND revoked_at IS NULL AND credential_hash=?) RETURNING job_id`,
      )
      .bind(
        now.toISOString(),
        this.context.ownerId,
        token.job_id,
        task,
        this.context.actorId,
        token.fencing_token,
        now.toISOString(),
        this.context.ownerId,
        this.context.actorId,
        this.context.credentialHash!,
      )
      .first<{ job_id: string }>();
    if (result?.job_id !== token.job_id) throw new Error('STALE_FENCE');
  }
  async heartbeat(
    token: LeaseToken,
    task: TaskType,
    now: Date,
    runtime: 'local' | 'cloud',
  ) {
    this.context.requireTask(task);
    if (token.lease_owner !== this.context.actorId)
      throw new Error('STALE_FENCE');
    const until = new Date(
      now.getTime() + (runtime === 'local' ? 900000 : 300000),
    ).toISOString();
    const result = await this.db
      .prepare(
        `UPDATE jobs SET lease_until=?,updated_at=? WHERE owner_id=? AND job_id=? AND task_type=? AND state IN ('LEASED','RUNNING') AND lease_owner=? AND fencing_token=? AND lease_until>?
      AND EXISTS(SELECT 1 FROM worker_identities WHERE owner_id=? AND worker_id=? AND revoked_at IS NULL AND credential_hash=?)`,
      )
      .bind(
        until,
        now.toISOString(),
        this.context.ownerId,
        token.job_id,
        task,
        this.context.actorId,
        token.fencing_token,
        now.toISOString(),
        this.context.ownerId,
        this.context.actorId,
        this.context.credentialHash!,
      )
      .run();
    if (result.meta.changes !== 1) throw new Error('STALE_FENCE');
    return { ...token, lease_until: until };
  }
  async disposition(
    token: LeaseToken,
    task: TaskType,
    state: Extract<JobState, 'DEFERRED' | 'RETRY_WAIT' | 'BLOCKED' | 'FAILED'>,
    reason: string,
    due: string,
    now: Date,
  ) {
    this.context.requireTask(task);
    if (token.lease_owner !== this.context.actorId)
      throw new Error('STALE_FENCE');
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE job_attempts SET finished_at=?,error_code=? WHERE owner_id=? AND job_id=? AND fencing_token=?
        AND EXISTS(SELECT 1 FROM jobs WHERE owner_id=? AND job_id=? AND task_type=? AND state='RUNNING' AND lease_owner=? AND fencing_token=? AND lease_until>?)
        AND EXISTS(SELECT 1 FROM worker_identities WHERE owner_id=? AND worker_id=? AND revoked_at IS NULL AND credential_hash=?) RETURNING job_id`,
        )
        .bind(
          now.toISOString(),
          reason,
          this.context.ownerId,
          token.job_id,
          token.fencing_token,
          this.context.ownerId,
          token.job_id,
          task,
          this.context.actorId,
          token.fencing_token,
          now.toISOString(),
          this.context.ownerId,
          this.context.actorId,
          this.context.credentialHash!,
        ),
      this.db
        .prepare(
          `UPDATE jobs SET state=?,reason_code=?,due_at=?,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE owner_id=? AND job_id=? AND task_type=? AND state='RUNNING' AND lease_owner=? AND fencing_token=? AND lease_until>?
        AND EXISTS(SELECT 1 FROM worker_identities WHERE owner_id=? AND worker_id=? AND revoked_at IS NULL AND credential_hash=?) RETURNING job_id`,
        )
        .bind(
          state,
          reason,
          due,
          now.toISOString(),
          this.context.ownerId,
          token.job_id,
          task,
          this.context.actorId,
          token.fencing_token,
          now.toISOString(),
          this.context.ownerId,
          this.context.actorId,
          this.context.credentialHash!,
        ),
    ]);
    if (results[1]?.results?.length !== 1) throw new Error('STALE_FENCE');
  }
}
