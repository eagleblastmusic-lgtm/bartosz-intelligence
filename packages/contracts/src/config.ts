export type Eligibility = 'VERIFIED_FREE' | 'INELIGIBLE' | 'UNKNOWN';
export interface RuntimePolicy {
  config_version: '1';
  paid_services_enabled: false;
  timezone: 'Europe/Warsaw';
  active_transcript_provider: string | null;
  ai_provider: string | null;
  deno_enabled: boolean;
  workers_ai_enabled: boolean;
  archive_enabled: boolean;
}
export interface ProviderDescriptor {
  readonly id: string;
  readonly version: string;
  readonly runtime: 'workerd' | 'node' | 'python';
  readonly kind: 'transcript' | 'ai' | 'archive';
  readonly enabled: boolean;
  readonly health: 'UNKNOWN' | 'AVAILABLE' | 'UNAVAILABLE';
  readonly eligibility: Eligibility;
  readonly eligibility_ref: string | null;
  readonly evidence_version: string | null;
  readonly evidence_runtime: string | null;
  readonly expires_at: string | null;
  readonly measurement_ref: string | null;
  readonly optional: 'deno' | 'workers_ai' | 'archive' | null;
  readonly billing: 'free' | 'paid' | 'trial' | 'unknown';
  readonly autopurchase: boolean;
  readonly approved_models: readonly string[];
  readonly capabilities: readonly string[];
  readonly allowed_origins: readonly string[];
}

export class PolicyError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'PolicyError';
  }
}

export function parsePolicy(input: unknown): Readonly<RuntimePolicy> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new PolicyError('CONFIG_OBJECT_REQUIRED');
  const value = input as Record<string, unknown>;
  const keys = [
    'config_version',
    'paid_services_enabled',
    'timezone',
    'active_transcript_provider',
    'ai_provider',
    'deno_enabled',
    'workers_ai_enabled',
    'archive_enabled',
  ];
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new PolicyError('CONFIG_FIELDS_INVALID');
  if (
    value.config_version !== '1' ||
    value.timezone !== 'Europe/Warsaw' ||
    value.paid_services_enabled !== false
  )
    throw new PolicyError('CONFIG_POLICY_INVALID');
  for (const key of ['active_transcript_provider', 'ai_provider']) {
    if (
      value[key] !== null &&
      (typeof value[key] !== 'string' ||
        !/^[a-z0-9_-]{1,64}$/.test(value[key] as string))
    )
      throw new PolicyError('CONFIG_PROVIDER_INVALID');
  }
  for (const key of ['deno_enabled', 'workers_ai_enabled', 'archive_enabled']) {
    if (typeof value[key] !== 'boolean')
      throw new PolicyError('CONFIG_FLAG_INVALID');
  }
  return Object.freeze({ ...value }) as unknown as Readonly<RuntimePolicy>;
}
