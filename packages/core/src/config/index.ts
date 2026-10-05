import { parsePolicy, PolicyError } from '../../../contracts/src/config.js';
import { fetchWithoutRedirect } from '../http/no-redirect.js';
import type {
  ProviderDescriptor,
  RuntimePolicy,
} from '../../../contracts/src/config.js';

export class ProviderRegistry {
  private readonly entries = new Map<string, Readonly<ProviderDescriptor>>();
  constructor(descriptors: readonly ProviderDescriptor[]) {
    for (const descriptor of descriptors) {
      if (
        !descriptor.id ||
        !descriptor.version ||
        this.entries.has(descriptor.id)
      )
        throw new PolicyError('REGISTRY_ID_VERSION_INVALID');
      this.entries.set(
        descriptor.id,
        Object.freeze({
          ...descriptor,
          capabilities: Object.freeze([...descriptor.capabilities]),
          approved_models: Object.freeze([...descriptor.approved_models]),
          allowed_origins: Object.freeze([...descriptor.allowed_origins]),
        }),
      );
    }
  }
  get(id: string) {
    const value = this.entries.get(id);
    if (!value) throw new PolicyError('PROVIDER_UNKNOWN');
    return value;
  }
}

export function admit(
  policy: Readonly<RuntimePolicy>,
  provider: Readonly<ProviderDescriptor>,
  now: number,
  model?: string,
) {
  parsePolicy(policy);
  if (!provider.enabled || provider.health !== 'AVAILABLE')
    throw new PolicyError('PROVIDER_UNAVAILABLE');
  if (
    provider.billing !== 'free' ||
    provider.autopurchase ||
    provider.eligibility !== 'VERIFIED_FREE'
  )
    throw new PolicyError('FREE_PROOF_REQUIRED');
  if (
    !provider.eligibility_ref ||
    provider.evidence_version !== provider.version ||
    provider.evidence_runtime !== provider.runtime
  )
    throw new PolicyError('EVIDENCE_MISMATCH');
  if (
    !provider.expires_at ||
    !Number.isFinite(Date.parse(provider.expires_at)) ||
    Date.parse(provider.expires_at) <= now
  )
    throw new PolicyError('EVIDENCE_EXPIRED');
  if (provider.optional && !provider.measurement_ref)
    throw new PolicyError('MEASUREMENT_REQUIRED');
  const selected =
    provider.kind === 'transcript'
      ? policy.active_transcript_provider
      : provider.kind === 'ai'
        ? policy.ai_provider
        : null;
  if (provider.kind !== 'archive' && selected !== provider.id)
    throw new PolicyError('PROVIDER_NOT_SELECTED');
  if (provider.optional && !policy[`${provider.optional}_enabled`])
    throw new PolicyError('OPTIONAL_DISABLED');
  if (
    provider.kind === 'ai' &&
    (!model || !provider.approved_models.includes(model))
  )
    throw new PolicyError('MODEL_UNVERIFIED');
}

export function loadConfig(
  input: unknown,
  registry: ProviderRegistry,
  now = Date.now(),
) {
  const policy = parsePolicy(input);
  for (const id of [policy.active_transcript_provider, policy.ai_provider]) {
    if (id) {
      const descriptor = registry.get(id);
      if (
        (id === policy.active_transcript_provider &&
          descriptor.kind !== 'transcript') ||
        (id === policy.ai_provider && descriptor.kind !== 'ai')
      )
        throw new PolicyError('PROVIDER_KIND_MISMATCH');
      admit(
        policy,
        descriptor,
        now,
        descriptor.kind === 'ai' ? descriptor.approved_models[0] : undefined,
      );
    }
  }
  for (const flag of ['deno', 'workers_ai', 'archive'] as const) {
    if (policy[`${flag}_enabled`]) {
      const ids = [
        policy.active_transcript_provider,
        policy.ai_provider,
      ].filter((id): id is string => id !== null);
      if (!ids.some((id) => registry.get(id).optional === flag))
        throw new PolicyError('OPTIONAL_ACTIVATION_MISSING');
    }
  }
  return policy;
}

export function publicConfig(policy: Readonly<RuntimePolicy>) {
  return Object.freeze({
    config_version: policy.config_version,
    timezone: policy.timezone,
  });
}

export async function guardedFetch(
  policy: Readonly<RuntimePolicy>,
  registry: ProviderRegistry,
  id: string,
  url: string,
  options: RequestInit = {},
  model?: string,
  transport: typeof fetch = fetch,
) {
  const provider = registry.get(id);
  admit(policy, provider, Date.now(), model);
  const target = new URL(url);
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    !provider.allowed_origins.includes(target.origin)
  )
    throw new PolicyError('PROVIDER_TARGET_DENIED');
  return fetchWithoutRedirect(target.href, options, transport);
}
