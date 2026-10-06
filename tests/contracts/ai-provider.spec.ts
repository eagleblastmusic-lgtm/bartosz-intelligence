import { it, expect } from 'vitest';
import { GeminiFreeProvider } from '../../packages/core/src/ai/gemini.js';
import { dailyQuotaWindow } from '../../packages/core/src/ai/windows.js';
import type { AIRequest } from '../../packages/contracts/src/ai.js';
import bundle from '../../config/registry/master-bundle.json';
const now = new Date('2026-10-06T00:00:00Z');
const request: AIRequest = {
  request_id: 'request',
  runtime: 'local',
  profile: {
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
    runtimes: ['local'],
    structured_output: true,
    context_tokens: 100000,
    output_tokens: 8192,
    rank: 1,
    quality_approvals: [],
    eligibility_expires_at: '2026-10-07T00:00:00Z',
  },
  prompt: 'source-only',
  wire_schema: bundle.schemas.find(
    (row) => row.id === 'urn:bartosz:schema:economy-wire:1.0',
  )!.schema,
  estimated_input_tokens: 1000,
  max_output_tokens: 512,
  deadline: '2026-10-06T00:01:00Z',
  quality_scope: 'economy:2',
  mode: 'QUALITY_TEST',
  paid_services_enabled: false,
};
it('one lean no-tools request consumes permit before transport and captures actual metadata', async () => {
  const events: string[] = [];
  const provider = new GeminiFreeProvider(
    'fixture-private-key',
    async () => {
      events.push('permit');
    },
    async (target, options) => {
      events.push('request');
      expect(target).toBe(
        'https://generativelanguage.googleapis.com/v1beta/interactions',
      );
      const body = JSON.parse(String(options?.body));
      expect(body.store).toBe(false);
      expect(body.tools).toBeUndefined();
      expect(body.response_format.schema.properties.item_id).toBeUndefined();
      expect(Object.keys(body.response_format.schema.properties)).toHaveLength(
        8,
      );
      expect(options?.redirect).toBe('manual');
      return new Response(
        JSON.stringify({
          model: 'gemini-3.8-flash',
          status: 'completed',
          steps: [
            { type: 'model_output', content: [{ type: 'text', text: '{}' }] },
          ],
          usage: {
            total_input_tokens: 100,
            total_output_tokens: 2,
            total_tokens: 102,
            total_thought_tokens: 4,
            raw_prompt_token: 120,
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
    () => now,
  );
  const result = await provider.run(request, {
    reservation_id: 'reserved',
    request_id: 'request',
  });
  expect(events).toEqual(['permit', 'request']);
  expect(result.status).toBe('OK');
  expect(result.usage.input_tokens).toBe(100);
  expect(result.actual_model).toBe('gemini-3.8-flash');
  expect(result.token_usage_numeric_fields).toMatchObject({
    raw_prompt_token: 120,
    total_thought_tokens: 4,
  });
  await expect(
    provider.run(
      { ...request, mode: 'PRODUCTION' },
      { reservation_id: 'x', request_id: 'request' },
    ),
  ).rejects.toThrow('AI_ADMISSION_DENIED');
  expect(events).toHaveLength(2);
});
it('paid/invalid permits never send, failures are redacted and never auto retry', async () => {
  let calls = 0;
  const provider = new GeminiFreeProvider(
    'fixture-private-key',
    async () => {},
    async () => {
      calls++;
      throw new Error('secret fixture-private-key');
    },
    () => now,
  );
  await expect(
    provider.run(
      { ...request, profile: { ...request.profile, billing_enabled: true } },
      { reservation_id: 'x', request_id: 'request' },
    ),
  ).rejects.toThrow('PAID_OR_UNQUALIFIED_ROUTE_DENIED');
  expect(calls).toBe(0);
  const failed = await provider.run(request, {
    reservation_id: 'x',
    request_id: 'request',
  });
  expect(calls).toBe(1);
  expect(failed.status).toBe('TEMPORARY_FAILURE');
  expect(JSON.stringify(failed)).not.toContain('fixture-private-key');
  expect(failed.usage.input_tokens).toBeNull();
  for (const [http, status] of [
    [429, 'RATE_LIMITED'],
    [403, 'AUTH_REQUIRED'],
    [503, 'TEMPORARY_FAILURE'],
    [400, 'INVALID_REQUEST'],
  ] as const) {
    const adapter = new GeminiFreeProvider(
      'fixture',
      async () => {},
      async () => new Response('private failure', { status: http }),
      () => now,
    );
    expect(
      (
        await adapter.run(request, {
          reservation_id: 'x',
          request_id: 'request',
        })
      ).status,
    ).toBe(status);
  }
});
it('daily Gemini LA windows follow DST while Cloudflare uses UTC', () => {
  for (const [instant, hours] of [
    ['2026-03-08T12:00:00Z', 23],
    ['2026-11-01T12:00:00Z', 25],
  ] as const) {
    const window = dailyQuotaWindow(new Date(instant), 'America/Los_Angeles');
    expect(
      (Date.parse(window.reset_at) - Date.parse(window.window_start)) / 3600000,
    ).toBe(hours);
  }
  expect(dailyQuotaWindow(now, 'UTC').reset_at).toBe(
    '2026-10-07T00:00:00.000Z',
  );
});
it('rate limiting retains only a parsed Retry-After boundary without retrying', async () => {
  for (const [header, expected] of [
    ['120', new Date(now.getTime() + 120000).toISOString()],
    ['private unknown', null],
  ] as const) {
    let calls = 0;
    const provider = new GeminiFreeProvider(
      'fixture',
      async () => {},
      async () => {
        calls++;
        return new Response('private error', {
          status: 429,
          headers: { 'Retry-After': header },
        });
      },
      () => now,
    );
    const result = await provider.run(request, {
      reservation_id: 'x',
      request_id: 'request',
    });
    expect(result).toMatchObject({
      status: 'RATE_LIMITED',
      retry_after: expected,
    });
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain('private');
  }
});
