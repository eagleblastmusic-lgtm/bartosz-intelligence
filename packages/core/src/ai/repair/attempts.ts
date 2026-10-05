import {
  assertContext,
  type AccessContext,
  type Database,
} from '../../db/boundary.js';
import { leasePredicate } from '../../jobs/lease-guard.js';
import type { LeaseToken } from '../../../../contracts/src/jobs.js';
export interface RepairAdmission {
  request_id: string;
  candidate_artifact_id: string;
  estimated_repair_tokens: number | null;
  estimated_full_retry_tokens: number | null;
  error_class: string;
  measurement_hash: string | null;
}
export function repairAdmissible(input: RepairAdmission) {
  return (
    Number.isSafeInteger(input.estimated_repair_tokens) &&
    Number.isSafeInteger(input.estimated_full_retry_tokens) &&
    input.estimated_repair_tokens! > 0 &&
    input.estimated_full_retry_tokens! > 0 &&
    input.estimated_repair_tokens! <=
      0.35 * input.estimated_full_retry_tokens! &&
    !!input.error_class &&
    /^[a-f0-9]{64}$/.test(input.measurement_hash ?? '')
  );
}
export class CandidateRepairAttempts {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async claim(input: RepairAdmission, token: LeaseToken, now: Date) {
    if (!repairAdmissible(input)) return false;
    const guard = leasePredicate(
      this.context,
      token,
      now.toISOString(),
      'ANALYZE',
    );
    const result = await this.db
      .prepare(
        `INSERT INTO candidate_repair_attempts(owner_id,item_id,candidate_artifact_id,job_id,fencing_token,request_id,estimated_repair_tokens,estimated_full_retry_tokens,error_class,measurement_hash,claimed_at)
      SELECT a.owner_id,a.item_id,a.artifact_id,?,?,?,?,?,?,?,? FROM artifacts a
      JOIN jobs j ON j.owner_id=a.owner_id AND j.item_id=a.item_id
      WHERE a.owner_id=? AND a.artifact_id=? AND a.kind='ANALYSIS_CANDIDATE' AND a.state='VERIFIED' AND j.job_id=? AND ${guard.predicate}
      ON CONFLICT DO NOTHING`,
      )
      .bind(
        token.job_id,
        token.fencing_token,
        input.request_id,
        input.estimated_repair_tokens!,
        input.estimated_full_retry_tokens!,
        input.error_class,
        input.measurement_hash!,
        now.toISOString(),
        this.context.ownerId,
        input.candidate_artifact_id,
        token.job_id,
        ...guard.bindings,
      )
      .run();
    return result.meta.changes === 1;
  }
}
