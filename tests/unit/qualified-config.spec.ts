import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import qualified from '../../config/qualified-runtime.json';
import selection from '../../config/provider-selection.json';
import type { ProviderDescriptor } from '../../packages/contracts/src/config.js';
import {
  ProviderRegistry,
  loadConfig,
  admit,
} from '../../packages/core/src/config/index.js';
const descriptors = qualified.descriptors as unknown as ProviderDescriptor[];
const now = Date.parse('2026-10-05T17:00:00Z');
it('admits exactly the measured local primary and canonical Free AI route', () => {
  const policy = loadConfig(
    qualified.policy,
    new ProviderRegistry(descriptors),
    now,
  );
  expect(policy.active_transcript_provider).toBe('local-ytdlp');
  expect(policy.ai_provider).toBe('gemini');
  expect(selection.transcript_roles.PRIMARY.runtime).toBe('python');
  const result = JSON.parse(
    readFileSync(selection.transcript_roles.PRIMARY.benchmark_ref!, 'utf8'),
  );
  expect(result.status).toBe('PASS');
  expect(result.criteria_version).toBe('gate0-criteria-v2');
  for (const provider of descriptors) {
    expect(provider.evidence_version).toBe(provider.version);
    expect(provider.evidence_runtime).toBe(provider.runtime);
    expect(provider.measurement_ref).toBeTruthy();
    expect(
      readFileSync(provider.measurement_ref!, 'utf8').length,
    ).toBeGreaterThan(0);
  }
});
it('rejects revoked evidence, paid/trial routes, stale eligibility and unapproved models', () => {
  const provider = descriptors.find((p) => p.id === 'gemini')!;
  for (const delta of [
    { evidence_version: 'old' },
    { evidence_runtime: 'python' },
    { billing: 'paid' },
    { billing: 'trial' },
    { eligibility: 'UNKNOWN' },
    { expires_at: '2020-01-01' },
    { autopurchase: true },
  ] as Partial<ProviderDescriptor>[])
    expect(() =>
      admit(
        qualified.policy as Parameters<typeof admit>[0],
        { ...provider, ...delta },
        now,
        'gemini-3.8-flash',
      ),
    ).toThrow();
  expect(() =>
    admit(
      qualified.policy as Parameters<typeof admit>[0],
      provider,
      now,
      'unapproved',
    ),
  ).toThrow('MODEL_UNVERIFIED');
});
