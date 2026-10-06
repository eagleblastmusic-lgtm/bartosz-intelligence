import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { leasePredicate } from '../jobs/lease-guard.js';
import type { LeaseToken } from '../../../contracts/src/jobs.js';
import type { AIResponse } from '../../../contracts/src/ai.js';
export interface AdmissionBucket {
  snapshot_id: string;
  bucket: 'RPM' | 'RPD' | 'INPUT_TPM';
  window_start: string;
  reset_at: string;
  remaining: number | null;
  sampled_at: string;
  expires_at: string;
  reserve: number;
}
export function validateAdmission(
  buckets: readonly AdmissionBucket[],
  inputTokens: number,
  now: Date,
) {
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 1 ||
    buckets.length !== 3 ||
    new Set(buckets.map((row) => row.bucket)).size !== 3
  )
    throw new Error('INVALID_RESERVATION');
  for (const row of buckets) {
    if (
      !['RPM', 'RPD', 'INPUT_TPM'].includes(row.bucket) ||
      !Number.isFinite(Date.parse(row.window_start)) ||
      !Number.isFinite(Date.parse(row.reset_at)) ||
      !Number.isFinite(Date.parse(row.expires_at)) ||
      Date.parse(row.window_start) > now.getTime() ||
      Date.parse(row.reset_at) <= now.getTime() ||
      Date.parse(row.expires_at) <= now.getTime() ||
      Date.parse(row.sampled_at) > now.getTime() ||
      Date.parse(row.sampled_at) < Date.parse(row.window_start) ||
      !Number.isFinite(Date.parse(row.sampled_at)) ||
      row.remaining === null ||
      !Number.isFinite(row.remaining) ||
      row.remaining < 0 ||
      !Number.isFinite(row.reserve) ||
      row.reserve < 0
    )
      throw new Error('QUOTA_UNKNOWN_OR_STALE');
  }
}
export class QuotaAdmission {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async reserve(
    input: {
      request_id: string;
      account_key: string;
      model: string;
      input_tokens: number;
      buckets: AdmissionBucket[];
      paid_services_enabled: boolean;
    },
    token: LeaseToken,
    now: Date,
  ) {
    if (input.paid_services_enabled)
      throw new Error('PAID_SERVICES_DISABLED_REQUIRED');
    validateAdmission(input.buckets, input.input_tokens, now);
    const guard = leasePredicate(
        this.context,
        token,
        now.toISOString(),
        'ANALYZE',
      ),
      id = crypto.randomUUID();
    const conditions: string[] = [],
      bindings: (string | number | null)[] = [];
    for (const row of input.buckets) {
      conditions.push(
        `EXISTS(SELECT 1 FROM quota_snapshots s WHERE s.owner_id=? AND s.snapshot_id=? AND s.provider='gemini' AND s.model=? AND s.bucket=? AND s.remaining=? AND s.reset_at=? AND s.sampled_at=? AND s.expires_at=? AND s.source IN ('api','dashboard') AND s.expires_at>? AND s.reset_at>?) AND ?+?+(SELECT COALESCE(SUM(${row.bucket === 'INPUT_TPM' ? 'charged_input_tokens' : '1'}),0) FROM quota_reservations r WHERE r.account_key=? AND r.provider='gemini' AND r.model=? AND r.state!='CANCELLED' AND r.created_at>=? AND (r.created_at>=? OR r.state IN ('RESERVED','SUBMITTED','UNKNOWN')))<=?`,
      );
      bindings.push(
        this.context.ownerId,
        row.snapshot_id,
        input.model,
        row.bucket,
        row.remaining,
        row.reset_at,
        row.sampled_at,
        row.expires_at,
        now.toISOString(),
        now.toISOString(),
        row.bucket === 'INPUT_TPM' ? input.input_tokens : 1,
        row.reserve,
        input.account_key,
        input.model,
        row.window_start,
        row.sampled_at,
        row.remaining!,
      );
    }
    const statement = this.db.prepare(
      `INSERT INTO quota_reservations(reservation_id,owner_id,job_id,fencing_token,request_id,provider,model,account_key,snapshots_json,input_tokens,charged_input_tokens,state,created_at,expires_at) SELECT ?,?,?,?,?,'gemini',?,?,?,?,?,'RESERVED',?,? WHERE ${guard.predicate} AND ${conditions.join(' AND ')} ON CONFLICT(owner_id,request_id) DO NOTHING`,
    );
    await statement
      .bind(
        id,
        this.context.ownerId,
        token.job_id,
        token.fencing_token,
        input.request_id,
        input.model,
        input.account_key,
        JSON.stringify(input.buckets),
        input.input_tokens,
        input.input_tokens,
        now.toISOString(),
        new Date(now.getTime() + 300000).toISOString(),
        ...guard.bindings,
        ...bindings,
      )
      .run();
    const result = await this.db
      .prepare(
        `SELECT reservation_id,job_id,fencing_token,account_key,model,input_tokens,state FROM quota_reservations WHERE owner_id=? AND request_id=? AND ${guard.predicate}`,
      )
      .bind(this.context.ownerId, input.request_id, ...guard.bindings)
      .first<{
        reservation_id: string;
        job_id: string;
        fencing_token: number;
        account_key: string;
        model: string;
        input_tokens: number;
        state: string;
      }>();
    if (!result) throw new Error('QUOTA_ADMISSION_DENIED');
    if (
      result.job_id !== token.job_id ||
      result.fencing_token !== token.fencing_token ||
      result.account_key !== input.account_key ||
      result.model !== input.model ||
      result.input_tokens !== input.input_tokens ||
      result.state !== 'RESERVED'
    )
      throw new Error('RESERVATION_CONFLICT');
    return {
      reservation_id: result.reservation_id,
      request_id: input.request_id,
    };
  }
  async submit(id: string, token: LeaseToken, now: Date) {
    const guard = leasePredicate(
      this.context,
      token,
      now.toISOString(),
      'ANALYZE',
    );
    const result = await this.db
      .prepare(
        `UPDATE quota_reservations SET state='SUBMITTED' WHERE owner_id=? AND reservation_id=? AND job_id=? AND fencing_token=? AND state='RESERVED' AND expires_at>? AND ${guard.predicate}`,
      )
      .bind(
        this.context.ownerId,
        id,
        token.job_id,
        token.fencing_token,
        now.toISOString(),
        ...guard.bindings,
      )
      .run();
    if (result.meta.changes !== 1)
      throw new Error('RESERVATION_NOT_SUBMITTABLE');
    return { reservation_id: id };
  }
  async reconcile(id: string, response: AIResponse, now: Date) {
    this.context.requireTask('ANALYZE');
    const usage = response.usage;
    for (const value of Object.values(usage))
      if (value !== null && (!Number.isSafeInteger(value) || value < 0))
        throw new Error('INVALID_USAGE');
    const reservation = await this.db
      .prepare(
        'SELECT model FROM quota_reservations WHERE owner_id=? AND reservation_id=? AND request_id=?',
      )
      .bind(this.context.ownerId, id, response.request_id)
      .first<{ model: string }>();
    const known =
      response.actual_provider === 'gemini' &&
      response.actual_model === reservation?.model &&
      usage.input_tokens !== null &&
      usage.output_tokens !== null &&
      usage.total_tokens !== null;
    const liveCredential =
      'EXISTS(SELECT 1 FROM worker_identities WHERE owner_id=? AND worker_id=? AND credential_hash=? AND revoked_at IS NULL)';
    const auth = [
      this.context.ownerId,
      this.context.actorId,
      this.context.credentialHash!,
    ] as const;
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO usage_records(usage_id,owner_id,reservation_id,request_id,input_tokens,output_tokens,total_tokens,actual_model,finish_reason,observed_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM quota_reservations WHERE owner_id=? AND reservation_id=? AND request_id=? AND state='SUBMITTED') AND ${liveCredential} ON CONFLICT(owner_id,reservation_id) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          this.context.ownerId,
          id,
          response.request_id,
          usage.input_tokens,
          usage.output_tokens,
          usage.total_tokens,
          response.actual_model,
          response.finish_reason,
          now.toISOString(),
          this.context.ownerId,
          id,
          response.request_id,
          ...auth,
        ),
      this.db
        .prepare(
          `UPDATE quota_reservations SET state=?,charged_input_tokens=CASE WHEN ?=1 THEN ? ELSE MAX(charged_input_tokens,COALESCE(?,charged_input_tokens)) END,settled_at=? WHERE owner_id=? AND reservation_id=? AND request_id=? AND state='SUBMITTED' AND EXISTS(SELECT 1 FROM usage_records WHERE owner_id=? AND reservation_id=?) AND ${liveCredential}`,
        )
        .bind(
          known ? 'SETTLED' : 'UNKNOWN',
          known ? 1 : 0,
          usage.input_tokens,
          usage.input_tokens,
          now.toISOString(),
          this.context.ownerId,
          id,
          response.request_id,
          this.context.ownerId,
          id,
          ...auth,
        ),
    ]);
    const row = await this.db
      .prepare(
        'SELECT request_id,input_tokens,output_tokens,total_tokens,finish_reason,actual_model FROM usage_records WHERE owner_id=? AND reservation_id=?',
      )
      .bind(this.context.ownerId, id)
      .first<{
        request_id: string;
        input_tokens: number | null;
        output_tokens: number | null;
        total_tokens: number | null;
        finish_reason: string;
        actual_model: string | null;
      }>();
    if (
      !row ||
      row.request_id !== response.request_id ||
      row.input_tokens !== usage.input_tokens ||
      row.output_tokens !== usage.output_tokens ||
      row.total_tokens !== usage.total_tokens ||
      row.finish_reason !== response.finish_reason ||
      row.actual_model !== response.actual_model
    )
      throw new Error('USAGE_RECONCILIATION_CONFLICT');
  }
}
