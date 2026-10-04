import { it, expect } from 'vitest';
import {
  parseEligibility,
  freeAdmission,
} from '../../tools/gates/eligibility-contract.js';
import type { EligibilitySnapshot } from '../../tools/gates/eligibility-contract.js';
const snapshot: EligibilitySnapshot = {
  service: 'fixture',
  account_pseudonym: 'account-fixture',
  region: 'PL',
  purpose: 'test-only',
  purpose_eligible: true,
  plan: 'FREE',
  free_eligible: 'VERIFIED_FREE',
  autopurchase: false,
  auth_scope: ['read'],
  sampled_at: '2026-10-04T12:00:00Z',
  expires_at: '2026-10-05T12:00:00Z',
  evidence_ref: 'fixture-only',
  billing_evidence_ref: 'fixture-only',
  limits: [
    {
      metric: 'requests',
      limit: 10,
      used: 1,
      remaining: 9,
      unit: 'requests',
      reset_at: '2026-10-05T07:00:00Z',
      reset_zone: 'America/Los_Angeles',
    },
  ],
};
const now = Date.parse('2026-10-04T16:00:00Z');
it('null quotas remain unknown, never infinite', () => {
  const value = parseEligibility({
    ...snapshot,
    limits: [{ ...snapshot.limits[0], limit: null }],
  });
  expect(value.limits[0]?.limit).toBeNull();
  expect(freeAdmission(value, now)).toBe('UNKNOWN_QUOTA');
});
it.each(['UTC', 'Europe/Warsaw', 'America/Los_Angeles'])(
  'preserves IANA reset zones: %s',
  (reset_zone) => {
    expect(
      parseEligibility({
        ...snapshot,
        limits: [{ ...snapshot.limits[0], reset_zone }],
      }).limits[0]?.reset_zone,
    ).toBe(reset_zone);
  },
);
it('rejects impossible numbers and invalid reset zone', () => {
  for (const limit of [Infinity, -1, NaN])
    expect(() =>
      parseEligibility({
        ...snapshot,
        limits: [{ ...snapshot.limits[0], limit }],
      }),
    ).toThrow('QUOTA_NUMBER_INVALID');
  expect(() =>
    parseEligibility({
      ...snapshot,
      limits: [{ ...snapshot.limits[0], reset_zone: 'not-a-zone' }],
    }),
  ).toThrow('QUOTA_ZONE_INVALID');
});
it('denies ineligible purpose and paid/trial/no billing proof', () => {
  expect(freeAdmission({ ...snapshot, purpose_eligible: false }, now)).toBe(
    'DENIED',
  );
  expect(freeAdmission({ ...snapshot, purpose_eligible: null }, now)).toBe(
    'DENIED',
  );
  expect(freeAdmission({ ...snapshot, plan: 'TRIAL' }, now)).toBe('DENIED');
  expect(freeAdmission({ ...snapshot, plan: 'PAID' }, now)).toBe('DENIED');
  expect(freeAdmission({ ...snapshot, billing_evidence_ref: null }, now)).toBe(
    'DENIED',
  );
});
it('expired/future evidence blocks admission', () => {
  expect(freeAdmission(snapshot, Date.parse('2026-10-06T00:00:00Z'))).toBe(
    'STALE',
  );
  expect(freeAdmission(snapshot, Date.parse('2026-10-01T00:00:00Z'))).toBe(
    'STALE',
  );
});
it('snapshot alone gives probe readiness, never PASS', () =>
  expect(freeAdmission(snapshot, now)).toBe('READY_FOR_LIVE_PROBE'));
it('unknown fields and non-pseudonym identity are rejected', () => {
  expect(() =>
    parseEligibility({ ...snapshot, api_key: 'test-secret' }),
  ).toThrow('ELIGIBILITY_FIELDS_INVALID');
  expect(() =>
    parseEligibility({ ...snapshot, account_pseudonym: 'email@example.test' }),
  ).toThrow('ELIGIBILITY_PSEUDONYM_REQUIRED');
});
