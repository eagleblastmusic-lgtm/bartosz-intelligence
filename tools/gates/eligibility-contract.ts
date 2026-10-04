import { PolicyError } from '../../packages/contracts/src/config.js';
import type { Eligibility } from '../../packages/contracts/src/config.js';

export interface EligibilitySnapshot {
  service: string;
  account_pseudonym: string;
  region: string | null;
  purpose: string;
  purpose_eligible: boolean | null;
  plan: 'FREE' | 'PAID' | 'TRIAL' | 'UNKNOWN';
  free_eligible: Eligibility;
  autopurchase: boolean;
  auth_scope: string[];
  sampled_at: string;
  expires_at: string;
  evidence_ref: string;
  billing_evidence_ref: string | null;
  limits: Array<{
    metric: string;
    limit: number | null;
    used: number | null;
    remaining: number | null;
    unit: string;
    reset_at: string | null;
    reset_zone: string;
  }>;
}

function fields(value: Record<string, unknown>, keys: readonly string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new PolicyError('ELIGIBILITY_FIELDS_INVALID');
}
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new PolicyError('ELIGIBILITY_OBJECT_REQUIRED');
  return input as Record<string, unknown>;
}
function iso(value: unknown) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
export function parseEligibility(input: unknown): EligibilitySnapshot {
  const value = record(input);
  fields(value, [
    'service',
    'account_pseudonym',
    'region',
    'purpose',
    'purpose_eligible',
    'plan',
    'free_eligible',
    'autopurchase',
    'auth_scope',
    'sampled_at',
    'expires_at',
    'evidence_ref',
    'billing_evidence_ref',
    'limits',
  ]);
  for (const key of ['service', 'account_pseudonym', 'purpose', 'evidence_ref'])
    if (typeof value[key] !== 'string' || !(value[key] as string).trim())
      throw new PolicyError('ELIGIBILITY_TEXT_INVALID');
  if (!/^[a-z0-9_-]+$/i.test(value.account_pseudonym as string))
    throw new PolicyError('ELIGIBILITY_PSEUDONYM_REQUIRED');
  if (value.region !== null && typeof value.region !== 'string')
    throw new PolicyError('ELIGIBILITY_REGION_INVALID');
  if (
    value.purpose_eligible !== null &&
    typeof value.purpose_eligible !== 'boolean'
  )
    throw new PolicyError('ELIGIBILITY_PURPOSE_INVALID');
  if (
    !['FREE', 'PAID', 'TRIAL', 'UNKNOWN'].includes(value.plan as string) ||
    !['VERIFIED_FREE', 'INELIGIBLE', 'UNKNOWN'].includes(
      value.free_eligible as string,
    ) ||
    typeof value.autopurchase !== 'boolean'
  )
    throw new PolicyError('ELIGIBILITY_POLICY_INVALID');
  if (
    value.billing_evidence_ref !== null &&
    typeof value.billing_evidence_ref !== 'string'
  )
    throw new PolicyError('ELIGIBILITY_BILLING_INVALID');
  if (
    !iso(value.sampled_at) ||
    !iso(value.expires_at) ||
    Date.parse(value.expires_at as string) <=
      Date.parse(value.sampled_at as string)
  )
    throw new PolicyError('ELIGIBILITY_TIME_INVALID');
  if (
    !Array.isArray(value.auth_scope) ||
    value.auth_scope.some((scope) => typeof scope !== 'string') ||
    !Array.isArray(value.limits)
  )
    throw new PolicyError('ELIGIBILITY_ARRAY_INVALID');
  for (const inputLimit of value.limits) {
    const limit = record(inputLimit);
    fields(limit, [
      'metric',
      'limit',
      'used',
      'remaining',
      'unit',
      'reset_at',
      'reset_zone',
    ]);
    for (const key of ['metric', 'unit', 'reset_zone'])
      if (typeof limit[key] !== 'string' || !limit[key])
        throw new PolicyError('QUOTA_TEXT_INVALID');
    for (const key of ['limit', 'used', 'remaining'])
      if (
        limit[key] !== null &&
        (typeof limit[key] !== 'number' ||
          !Number.isFinite(limit[key]) ||
          (limit[key] as number) < 0)
      )
        throw new PolicyError('QUOTA_NUMBER_INVALID');
    if (limit.reset_at !== null && !iso(limit.reset_at))
      throw new PolicyError('QUOTA_RESET_INVALID');
    try {
      new Intl.DateTimeFormat('en', { timeZone: limit.reset_zone as string });
    } catch {
      throw new PolicyError('QUOTA_ZONE_INVALID');
    }
  }
  return structuredClone(value) as unknown as EligibilitySnapshot;
}

// This determines admission readiness, never a live Gate E PASS.
export function freeAdmission(snapshot: EligibilitySnapshot, now: number) {
  parseEligibility(snapshot);
  if (
    snapshot.free_eligible !== 'VERIFIED_FREE' ||
    snapshot.plan !== 'FREE' ||
    snapshot.purpose_eligible !== true ||
    !snapshot.region ||
    snapshot.autopurchase ||
    !snapshot.billing_evidence_ref
  )
    return 'DENIED';
  if (
    Date.parse(snapshot.sampled_at) > now ||
    Date.parse(snapshot.expires_at) <= now ||
    now - Date.parse(snapshot.sampled_at) > 86400000
  )
    return 'STALE';
  if (
    !snapshot.limits.length ||
    snapshot.limits.some(
      (limit) =>
        limit.limit === null ||
        limit.remaining === null ||
        limit.reset_at === null ||
        Date.parse(limit.reset_at) <= now,
    )
  )
    return 'UNKNOWN_QUOTA';
  return 'READY_FOR_LIVE_PROBE';
}
