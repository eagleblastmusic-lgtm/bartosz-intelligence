import { it, expect } from 'vitest';
import {
  extractTokenAccounting,
  validTokenAccounting,
} from '../../packages/core/src/ai/accounting.js';
it('preserves bounded actual numeric fields without strings, invented zeroes or arbitrary keys', () => {
  const actual = extractTokenAccounting({
    total_input_tokens: 19,
    raw_prompt_token: 100,
    total_thought_tokens: 0,
    untrusted: 'secret',
    secret_key: 123,
    total_output_tokens: null,
    model_invocation_token_counts: [
      {
        prompt_tokens_details: [{ tokens: 100, label: 'private' }],
        candidates_tokens_details: [{ tokens: 25 }],
      },
    ],
  });
  expect(actual).toEqual({
    total_input_tokens: 19,
    raw_prompt_token: 100,
    total_thought_tokens: 0,
    'model_invocation_token_counts[0].prompt_tokens_details[0].tokens': 100,
    'model_invocation_token_counts[0].candidates_tokens_details[0].tokens': 25,
  });
  expect(validTokenAccounting(actual)).toBe(true);
  expect(validTokenAccounting({ secret_key: 123 })).toBe(false);
  expect(validTokenAccounting({ raw_prompt_token: -1 })).toBe(false);
  expect(extractTokenAccounting(null)).toBeNull();
  const many = extractTokenAccounting({
    model_invocation_token_counts: Array.from({ length: 100 }, () => ({
      prompt_tokens_details: Array.from({ length: 100 }, () => ({ tokens: 1 })),
      candidates_tokens_details: Array.from({ length: 100 }, () => ({
        tokens: 1,
      })),
    })),
  });
  expect(Object.keys(many!)).toHaveLength(48);
  expect(
    new TextEncoder().encode(JSON.stringify(many)).byteLength,
  ).toBeLessThan(7000);
  expect(validTokenAccounting(many)).toBe(true);
});
