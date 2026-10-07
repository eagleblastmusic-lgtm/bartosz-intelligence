import { it, expect } from 'vitest';
import {
  validateLabControls,
  type LabControls,
} from '../../packages/core/src/registry/lab.js';
export function controls(): LabControls {
  const base = {
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    model_revision: 1,
    prompt_hash: 'a'.repeat(64),
    wire_hash: 'b'.repeat(64),
    canonical_hash: 'c'.repeat(64),
    reasoning: 'low',
    max_output_tokens: 128,
    seed: null,
  };
  return {
    version: 'lab-controls:1',
    mode: 'PROMPT_AB',
    source_hashes: ['d'.repeat(64)],
    repeats: 3,
    variants: [
      { ...base, id: 'A' },
      { ...base, id: 'B', prompt_hash: 'e'.repeat(64) },
    ],
    confounders: ['SEED_UNAVAILABLE', 'PROVIDER_NONDETERMINISM'],
  };
}
it('pins controlled prompt comparisons and returns an independent frozen value', () => {
  const input = controls(),
    result = validateLabControls(input);
  input.variants[0].model = 'changed';
  expect(result.variants[0].model).toBe('gemini-3.8-flash');
});
it.each([
  'model',
  'model_revision',
  'wire_hash',
  'canonical_hash',
  'reasoning',
  'max_output_tokens',
  'seed',
] as const)('rejects confounded prompt comparison: %s', (key) => {
  const input = controls();
  Object.assign(input.variants[1], {
    [key]: key.endsWith('hash')
      ? 'f'.repeat(64)
      : key === 'model_revision' ||
          key === 'max_output_tokens' ||
          key === 'seed'
        ? 9
        : 'changed',
  });
  expect(() => validateLabControls(input)).toThrow();
});
it('requires real model differences, same prompt and recorded model reasoning confounder', () => {
  const input = controls();
  input.mode = 'MODEL_AB';
  input.variants[1].prompt_hash = input.variants[0].prompt_hash;
  expect(() => validateLabControls(input)).toThrow(
    'LAB_COMPARISON_AXIS_MISMATCH',
  );
  input.variants[1].model = 'future-free-adapter';
  expect(() => validateLabControls(input)).toThrow(
    'LAB_CONFOUNDER_NOT_RECORDED',
  );
  input.confounders.push('MODEL_REASONING_IMPLEMENTATION');
  expect(validateLabControls(input).mode).toBe('MODEL_AB');
});
it('does not invent seed support or drop nondeterminism metadata', () => {
  const input = controls();
  input.variants[0].seed = input.variants[1].seed = 42;
  expect(() => validateLabControls(input)).toThrow('LAB_SEED_UNSUPPORTED');
  input.variants[0].seed = input.variants[1].seed = null;
  input.confounders = [];
  expect(() => validateLabControls(input)).toThrow(
    'LAB_CONFOUNDER_NOT_RECORDED',
  );
});
