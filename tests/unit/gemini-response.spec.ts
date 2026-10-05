import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGeminiProbeResponse } from '../../tools/gates/gemini-response.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(`tests/fixtures/gemini/${name}`, 'utf8')) as unknown;

describe('Gemini endpoint response parser', () => {
  it('parses generateContent candidates, finish reason, model and token usage', () => {
    const result = parseGeminiProbeResponse(
      'generateContent',
      200,
      'application/json; charset=UTF-8',
      fixture('generate-content-success.json'),
    );
    expect(result).toMatchObject({
      http_status: 200,
      json_valid: true,
      finish_reason: 'STOP',
      model_identifier: 'gemini-3.8-flash',
      token_usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
      token_usage_numeric_fields: {
        promptTokenCount: 12,
        candidatesTokenCount: 5,
        totalTokenCount: 17,
        thoughtsTokenCount: 2,
      },
      structured_output_valid: true,
      failure_reason: null,
    });
    expect(result.json_shape.candidate_count).toBe(1);
  });

  it('parses Interactions steps, completion status, model and token usage', () => {
    const result = parseGeminiProbeResponse(
      'interactions',
      200,
      'application/json',
      fixture('interactions-success.json'),
    );
    expect(result).toMatchObject({
      http_status: 200,
      json_valid: true,
      finish_reason: 'completed',
      model_identifier: 'gemini-3.8-flash',
      token_usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
      token_usage_numeric_fields: {
        total_input_tokens: 12,
        total_output_tokens: 5,
        total_tokens: 17,
        total_thought_tokens: 2,
      },
      structured_output_valid: true,
      failure_reason: null,
    });
    expect(result.json_shape.step_types).toEqual(['model_output']);
  });

  it('captures an incomplete Interactions response without treating it as provider unavailability', () => {
    const result = parseGeminiProbeResponse(
      'interactions',
      200,
      'application/json',
      fixture('interactions-incomplete.json'),
    );
    expect(result).toMatchObject({
      http_status: 200,
      json_valid: true,
      finish_reason: 'incomplete',
      model_identifier: 'gemini-3.8-flash',
      token_usage: { input_tokens: 19, output_tokens: 0, total_tokens: 79 },
      token_usage_numeric_fields: {
        total_input_tokens: 19,
        total_output_tokens: 0,
        total_tokens: 79,
        total_thought_tokens: 60,
      },
      structured_output_valid: false,
      failure_reason: 'INTERACTION_INCOMPLETE_OUTPUT_BUDGET',
    });
  });

  it('rejects wrong status, media type, endpoint shape and invalid JSON output', () => {
    expect(
      parseGeminiProbeResponse(
        'generateContent',
        200,
        'text/plain',
        fixture('generate-content-success.json'),
      ).failure_reason,
    ).toBe('CONTENT_TYPE_NOT_JSON');
    expect(
      parseGeminiProbeResponse(
        'generateContent',
        503,
        'application/json',
        fixture('generate-content-success.json'),
      ).failure_reason,
    ).toBe('HTTP_503');
    expect(
      parseGeminiProbeResponse(
        'interactions',
        200,
        'application/json',
        fixture('generate-content-success.json'),
      ).failure_reason,
    ).toBe('INTERACTION_STATUS_NOT_COMPLETED');
    const bad = {
      ...(fixture('interactions-success.json') as Record<string, unknown>),
      steps: [
        { type: 'model_output', content: [{ type: 'text', text: '{bad' }] },
      ],
    };
    expect(
      parseGeminiProbeResponse('interactions', 200, 'application/json', bad)
        .failure_reason,
    ).toBe('STRUCTURED_OUTPUT_JSON_INVALID');
  });
});
