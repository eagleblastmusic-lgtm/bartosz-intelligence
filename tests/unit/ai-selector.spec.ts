import { it, expect } from 'vitest';
import {
  selectPipeline,
  type SelectionContext,
} from '../../packages/core/src/ai/selector.js';
import { validateAdmission } from '../../packages/core/src/ai/admission.js';
import type { PipelineProfile } from '../../packages/contracts/src/ai.js';
const now = new Date('2026-10-06T00:00:00Z');
const profile: PipelineProfile = {
  profile_id: 'gemini_free',
  revision: 1,
  provider_id: 'gemini',
  model: 'gemini-3.8-flash',
  account_key: 'project',
  free_eligible: true,
  billing_enabled: false,
  purposes: ['professional_single_owner'],
  regions: ['PL'],
  task_types: ['ECONOMY'],
  runtimes: ['local', 'cloud'],
  structured_output: true,
  context_tokens: 100000,
  output_tokens: 8192,
  rank: 1,
  quality_approvals: [],
  eligibility_expires_at: '2026-10-07T00:00:00Z',
};
const context: SelectionContext = {
  profile_id: 'gemini_free',
  purpose: 'professional_single_owner',
  region: 'PL',
  task_type: 'ECONOMY',
  runtime: 'local',
  mode: 'QUALITY_TEST',
  quality_scope: 'economy:2',
  input_tokens: 1000,
  output_tokens: 1000,
  now,
  paid_services_enabled: false,
};
it('filters free purpose, scope and independent execution runtime without auto promotion', () => {
  expect(selectPipeline([profile], context).profile?.model).toBe(
    'gemini-3.8-flash',
  );
  expect(
    selectPipeline([profile], { ...context, mode: 'PRODUCTION' }).reason,
  ).toBe('QUALITY_SCOPE');
  expect(
    selectPipeline([{ ...profile, billing_enabled: true }], context).reason,
  ).toBe('FREE_ELIGIBILITY');
  expect(
    selectPipeline([profile], { ...context, purpose: 'public_saas' }).reason,
  ).toBe('ACCOUNT_PURPOSE_REGION');
  expect(
    selectPipeline([profile], { ...context, paid_services_enabled: true })
      .profile,
  ).toBeNull();
  expect(
    selectPipeline([{ ...profile, runtimes: ['local'] }], {
      ...context,
      runtime: 'cloud',
    }).reason,
  ).toBe('RUNTIME_BUDGET');
});
it('unknown quota never becomes unlimited', () => {
  expect(() => validateAdmission([], 100, now)).toThrow('INVALID_RESERVATION');
  const buckets = ['RPM', 'RPD', 'INPUT_TPM'].map((bucket) => ({
    bucket: bucket as 'RPM',
    snapshot_id: bucket,
    window_start: now.toISOString(),
    reset_at: '2026-10-06T01:00:00Z',
    sampled_at: now.toISOString(),
    expires_at: '2026-10-06T00:01:00Z',
    remaining: null,
    reserve: 0,
  }));
  expect(() => validateAdmission(buckets, 100, now)).toThrow(
    'QUOTA_UNKNOWN_OR_STALE',
  );
});
