import type { PipelineProfile } from '../../../contracts/src/ai.js';
export interface SelectionContext {
  profile_id: string;
  purpose: string;
  region: string;
  task_type: string;
  runtime: 'local' | 'cloud';
  mode: 'PRODUCTION' | 'QUALITY_TEST';
  quality_scope: string;
  input_tokens: number;
  output_tokens: number;
  now: Date;
  paid_services_enabled: boolean;
}
export function selectPipeline(
  profiles: readonly PipelineProfile[],
  context: SelectionContext,
) {
  if (context.paid_services_enabled)
    return { profile: null, reason: 'PAID_SERVICES_DISABLED_REQUIRED' };
  let candidates = profiles.filter(
    (profile) => profile.profile_id === context.profile_id,
  );
  const filters: [string, (profile: PipelineProfile) => boolean][] = [
    [
      'ACCOUNT_PURPOSE_REGION',
      (p) =>
        p.purposes.includes(context.purpose) &&
        p.regions.includes(context.region) &&
        Date.parse(p.eligibility_expires_at) > context.now.getTime(),
    ],
    ['FREE_ELIGIBILITY', (p) => p.free_eligible && !p.billing_enabled],
    [
      'TASK_CAPABILITY',
      (p) => p.structured_output && p.task_types.includes(context.task_type),
    ],
    [
      'QUALITY_SCOPE',
      (p) =>
        context.mode === 'QUALITY_TEST' ||
        p.quality_approvals.includes(context.quality_scope),
    ],
    [
      'RUNTIME_BUDGET',
      (p) =>
        p.runtimes.includes(context.runtime) &&
        context.input_tokens + context.output_tokens <= p.context_tokens &&
        context.output_tokens <= p.output_tokens,
    ],
  ];
  for (const [reason, filter] of filters) {
    candidates = candidates.filter(filter);
    if (!candidates.length) return { profile: null, reason };
  }
  candidates.sort(
    (a, b) =>
      a.rank - b.rank ||
      b.revision - a.revision ||
      a.model.localeCompare(b.model),
  );
  return { profile: structuredClone(candidates[0]!), reason: null };
}
