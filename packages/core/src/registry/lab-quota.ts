import { sha256 } from '../auth/crypto.js';
import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
export interface LabQuotaPolicy {
  version: 'lab-quota:1';
  account_key: string;
  model: string;
  daily_requests: number;
  normal_headroom: { RPM: number; RPD: number; INPUT_TPM: number };
}
function validate(input: LabQuotaPolicy) {
  if (
    !input ||
    Object.keys(input).length !== 5 ||
    input.version !== 'lab-quota:1' ||
    typeof input.account_key !== 'string' ||
    !input.account_key ||
    input.account_key.length > 200 ||
    typeof input.model !== 'string' ||
    !input.model ||
    input.model.length > 200 ||
    !Number.isSafeInteger(input.daily_requests) ||
    input.daily_requests < 0 ||
    !input.normal_headroom ||
    Object.keys(input.normal_headroom).length !== 3 ||
    ['RPM', 'RPD', 'INPUT_TPM'].some((key) => {
      const value =
        input.normal_headroom[key as keyof LabQuotaPolicy['normal_headroom']];
      return !Number.isSafeInteger(value) || value < 1;
    })
  )
    throw new Error('INVALID_LAB_QUOTA_POLICY');
  return structuredClone(input);
}
/** A separate Lab allowance does not replace official global quota observations. */
export class LabQuotaPolicies {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async current() {
    const row = await this.db
      .prepare(
        "SELECT revision,payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id='lab-quota-gemini_free' ORDER BY revision DESC LIMIT 1",
      )
      .bind(this.context.ownerId)
      .first<{
        revision: number;
        payload_json: string;
        content_hash: string;
      }>();
    if (!row) return null;
    if ((await sha256(row.payload_json)) !== row.content_hash)
      throw new Error('QUOTA_LAB_POLICY_HASH_MISMATCH');
    const stored = JSON.parse(row.payload_json) as {
      policy: LabQuotaPolicy;
      reason: string;
      created_by: string;
      created_at: string;
    };
    return {
      revision: row.revision,
      hash: row.content_hash,
      ...stored,
      policy: validate(stored.policy),
    };
  }
  async save(
    policy: LabQuotaPolicy,
    expectedRevision: number,
    reason: string,
    now: Date,
  ) {
    this.context.requireOwner();
    validate(policy);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      typeof reason !== 'string' ||
      !reason.trim() ||
      reason.length > 1000 ||
      !Number.isFinite(now.getTime())
    )
      throw new Error('INVALID_LAB_QUOTA_POLICY');
    const prior = await this.current();
    if (
      prior?.revision === expectedRevision + 1 &&
      JSON.stringify(prior.policy) === JSON.stringify(validate(policy)) &&
      prior.reason === reason.trim()
    )
      return prior;
    const stored = {
      policy: validate(policy),
      reason: reason.trim(),
      created_by: this.context.actorId,
      created_at: now.toISOString(),
    };
    const serialized = JSON.stringify(stored),
      hash = await sha256(serialized),
      revision = expectedRevision + 1;
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO config_versions SELECT 'lab-quota-gemini_free',?,?,?,?,? WHERE COALESCE((SELECT MAX(revision) FROM config_versions WHERE owner_id=? AND config_id='lab-quota-gemini_free'),0)=? ON CONFLICT DO NOTHING",
        )
        .bind(
          this.context.ownerId,
          revision,
          serialized,
          hash,
          now.toISOString(),
          this.context.ownerId,
          expectedRevision,
        ),
      this.db
        .prepare(
          "INSERT INTO audit_events SELECT ?,?,?,'LAB_QUOTA_POLICY_CHANGED',?,?,? WHERE changes()=1 ON CONFLICT DO NOTHING",
        )
        .bind(
          `lab-quota-${this.context.ownerId}-${revision}`,
          this.context.ownerId,
          this.context.actorId,
          'lab-quota-gemini_free',
          hash,
          now.toISOString(),
        ),
    ]);
    const result = await this.current();
    if (result?.revision !== revision || result.hash !== hash)
      throw new Error('REGISTRY_GENERATION_CONFLICT');
    return result;
  }
}
