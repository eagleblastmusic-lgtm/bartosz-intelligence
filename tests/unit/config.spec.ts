import { describe, it, expect, vi } from 'vitest';
import defaults from '../../config/defaults.json';
import { parsePolicy } from '../../packages/contracts/src/config.js';
import type { ProviderDescriptor } from '../../packages/contracts/src/config.js';
import {
  loadConfig,
  ProviderRegistry,
  guardedFetch,
  publicConfig,
} from '../../packages/core/src/config/index.js';
import { logRecord } from '../../packages/telemetry/src/redact.js';

const descriptor: ProviderDescriptor = {
  id: 'test-ai',
  version: '1',
  runtime: 'node',
  kind: 'ai',
  enabled: true,
  health: 'AVAILABLE',
  eligibility: 'VERIFIED_FREE',
  eligibility_ref: 'test-only',
  evidence_version: '1',
  evidence_runtime: 'node',
  expires_at: '2099-01-01T00:00:00Z',
  measurement_ref: null,
  optional: null,
  billing: 'free',
  autopurchase: false,
  approved_models: ['approved'],
  capabilities: ['structured'],
  allowed_origins: ['https://example.com'],
};
const policy = parsePolicy({ ...defaults, ai_provider: 'test-ai' });

describe('hard Free policy', () => {
  it('loads disabled defaults and exposes only public fields', () => {
    expect(loadConfig(defaults, new ProviderRegistry([]))).toEqual(defaults);
    expect(Object.keys(publicConfig(policy))).toEqual([
      'config_version',
      'timezone',
    ]);
  });
  it.each([
    { paid_services_enabled: true },
    { timezone: 'UTC' },
    { unknown: 'secret' },
    { deno_enabled: 'true' },
  ])('rejects malformed config without printing values: %j', (delta) => {
    expect(() => parsePolicy({ ...defaults, ...delta })).toThrow(/^CONFIG_/);
  });
  it('rejects activation without matching optional component', () => {
    expect(() =>
      loadConfig(
        { ...defaults, archive_enabled: true },
        new ProviderRegistry([]),
      ),
    ).toThrow('OPTIONAL_ACTIVATION_MISSING');
  });
  it.each([
    { billing: 'paid' },
    { billing: 'trial' },
    { eligibility: 'UNKNOWN' },
    { eligibility: 'INELIGIBLE' },
    { eligibility_ref: null },
    { expires_at: '2000-01-01' },
    { evidence_version: '2' },
    { evidence_runtime: 'python' },
    { autopurchase: true },
    { optional: 'workers_ai', measurement_ref: null },
    { enabled: false },
  ] as Partial<ProviderDescriptor>[])(
    'denies network before transport: %j',
    async (delta) => {
      const network = vi.fn<typeof fetch>();
      const registry = new ProviderRegistry([{ ...descriptor, ...delta }]);
      await expect(
        guardedFetch(
          policy,
          registry,
          'test-ai',
          'https://example.com',
          {},
          'approved',
          network,
        ),
      ).rejects.toThrow();
      expect(network).not.toHaveBeenCalled();
    },
  );
  it('presence of a paid key grants no route', async () => {
    const prior = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-secret-not-a-real-key';
    const network = vi.fn<typeof fetch>();
    try {
      await expect(
        guardedFetch(
          parsePolicy(defaults),
          new ProviderRegistry([descriptor]),
          'test-ai',
          'https://example.com',
          {},
          'approved',
          network,
        ),
      ).rejects.toThrow('PROVIDER_NOT_SELECTED');
      expect(network).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prior;
    }
  });
  it('rejects unapproved model and target', async () => {
    const network = vi.fn<typeof fetch>();
    const registry = new ProviderRegistry([descriptor]);
    await expect(
      guardedFetch(
        policy,
        registry,
        'test-ai',
        'https://example.com',
        {},
        'new-model',
        network,
      ),
    ).rejects.toThrow('MODEL_UNVERIFIED');
    await expect(
      guardedFetch(
        policy,
        registry,
        'test-ai',
        'http://127.0.0.1',
        {},
        'approved',
        network,
      ),
    ).rejects.toThrow('PROVIDER_TARGET_DENIED');
    expect(network).not.toHaveBeenCalled();
  });
  it('submits only eligible selected route; redirects fail closed', async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    await guardedFetch(
      policy,
      new ProviderRegistry([descriptor]),
      'test-ai',
      'https://example.com',
      {},
      'approved',
      network,
    );
    expect(network).toHaveBeenCalledExactlyOnceWith('https://example.com/', {
      redirect: 'manual',
    });
  });
  it('makes copied descriptors immutable', () => {
    const registry = new ProviderRegistry([descriptor]);
    expect(Object.isFrozen(registry.get('test-ai'))).toBe(true);
    expect(Object.isFrozen(registry.get('test-ai').approved_models)).toBe(true);
    expect(() => new ProviderRegistry([descriptor, descriptor])).toThrow();
  });
  it('redacts nested logs, headers, query strings and explicit secret values', () => {
    const text = logRecord(
      'test',
      {
        Authorization: 'Bearer abc',
        nested: { token: 'xyz' },
        url: 'https://example.com?key=private',
        message: 'secret-value',
      },
      ['secret-value'],
    );
    for (const value of ['abc', 'xyz', 'private', 'secret-value'])
      expect(text).not.toContain(value);
    expect(text).toContain('[REDACTED]');
    expect(() =>
      parsePolicy({ ...defaults, unknown: 'secret-value' }),
    ).not.toThrow(/secret-value/);
  });
});
