import { it, expect } from 'vitest';
import { GeminiFreeProvider } from '../../packages/core/src/ai/gemini.js';
import { dailyQuotaWindow } from '../../packages/core/src/ai/windows.js';
import type { AIRequest } from '../../packages/contracts/src/ai.js';
import bundle from '../../config/registry/master-bundle.json';
import {
  compileSemanticProfile,
  semanticModules,
} from '../../packages/core/src/ai/semantic-profile.js';
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
it.each(['FULL', 'CUSTOM'] as const)(
  'sends only the compiled %s schema after its permit, preserving free-tier guards',
  async (mode) => {
    const semantic = await compileSemanticProfile(
      {
        mode,
        modules: Object.fromEntries(
          semanticModules.map((key) => [
            key,
            mode === 'FULL' || key === 'usage',
          ]),
        ),
        translation: 'NONE',
        history: false,
        second_pass: null,
        validation_pass: null,
      },
      bundle,
    );
    const events: string[] = [];
    const provider = new GeminiFreeProvider(
      'fixture',
      async () => {
        events.push('permit');
      },
      async (_target, options) => {
        events.push('transport');
        const body = JSON.parse(String(options?.body));
        expect(Object.keys(body.response_format.schema.properties)).toEqual(
          Object.keys(
            semantic.wire.schema.properties as Record<string, unknown>,
          ),
        );
        expect(body.store).toBe(false);
        expect(body.tools).toBeUndefined();
        return new Response(
          JSON.stringify({
            model: request.profile.model,
            status: 'completed',
            steps: [
              { type: 'model_output', content: [{ type: 'text', text: '{}' }] },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
      () => now,
    );
    const scoped = {
      ...request,
      wire_schema: semantic.wire.schema,
      profile: { ...request.profile, task_types: [mode] },
    };
    const permit = {
      reservation_id: 'reserved',
      request_id: request.request_id,
    };
    expect((await provider.run(scoped, permit)).status).toBe('OK');
    expect(events).toEqual(['permit', 'transport']);
    await expect(
      provider.run({ ...scoped, mode: 'PRODUCTION' }, permit),
    ).rejects.toThrow('AI_ADMISSION_DENIED');
    await expect(
      provider.run(
        { ...scoped, profile: { ...scoped.profile, billing_enabled: true } },
        permit,
      ),
    ).rejects.toThrow('PAID_OR_UNQUALIFIED_ROUTE_DENIED');
    expect(events).toHaveLength(2);
  },
);
it('uses generateContent only for explicit quality comparison, preserving prompt/schema/accounting and refusing production', async () => {
  const events: string[] = [];
  const provider = new GeminiFreeProvider(
    'fixture',
    async () => {
      events.push('permit');
    },
    async (url, options) => {
      events.push('transport');
      expect(String(url)).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
      );
      const body = JSON.parse(String(options?.body));
      expect(body.contents).toEqual([
        { role: 'user', parts: [{ text: request.prompt }] },
      ]);
      expect(body.tools).toBeUndefined();
      expect(body.generationConfig.responseFormat.text.mimeType).toBe(
        'application/json',
      );
      expect(
        Object.keys(
          body.generationConfig.responseFormat.text.schema.properties,
        ),
      ).toEqual(
        Object.keys(request.wire_schema.properties as Record<string, unknown>),
      );
      return Response.json({
        modelVersion: request.profile.model,
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                { text: 'hidden thought', thought: true },
                { text: '{"test":true}' },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 19,
          candidatesTokenCount: 7,
          totalTokenCount: 30,
          thoughtsTokenCount: 4,
        },
      });
    },
    () => now,
    'generateContent',
  );
  const permit = { reservation_id: 'reserved', request_id: request.request_id };
  const response = await provider.run(request, permit);
  expect(response).toMatchObject({
    status: 'OK',
    raw_output: '{"test":true}',
    actual_model: request.profile.model,
    usage: { input_tokens: 19, output_tokens: 7, total_tokens: 30 },
    token_usage_numeric_fields: { total_thought_tokens: 4 },
  });
  expect(events).toEqual(['permit', 'transport']);
  await expect(
    provider.run({ ...request, mode: 'PRODUCTION' }, permit),
  ).rejects.toThrow('DIAGNOSTIC_ENDPOINT_SCOPE_DENIED');
  await expect(
    provider.run(
      { ...request, profile: { ...request.profile, billing_enabled: true } },
      permit,
    ),
  ).rejects.toThrow('PAID_OR_UNQUALIFIED_ROUTE_DENIED');
  expect(events).toHaveLength(2);
});
it.each([
  'MAX_TOKENS',
  'SAFETY',
  'TOOL_OUTPUT',
  'MODEL_MISMATCH',
  'MULTIPLE',
  'MISSING_USAGE',
])(
  'retains diagnostic generateContent %s without inventing success or usage',
  async (fault) => {
    const provider = new GeminiFreeProvider(
      'fixture',
      async () => {},
      async () =>
        Response.json({
          modelVersion:
            fault === 'MODEL_MISMATCH' ? 'gemini-other' : request.profile.model,
          candidates: Array.from(
            { length: fault === 'MULTIPLE' ? 2 : 1 },
            () => ({
              finishReason: ['MAX_TOKENS', 'SAFETY'].includes(fault)
                ? fault
                : 'STOP',
              content: {
                parts:
                  fault === 'TOOL_OUTPUT'
                    ? [{ functionCall: { name: 'forbidden' } }]
                    : [{ text: '{}' }],
              },
            }),
          ),
          ...(fault === 'MISSING_USAGE'
            ? {}
            : {
                usageMetadata: {
                  promptTokenCount: 1,
                  candidatesTokenCount: 2,
                  totalTokenCount: 3,
                },
              }),
        }),
      () => now,
      'generateContent',
    );
    const response = await provider.run(request, {
      reservation_id: 'reserved',
      request_id: request.request_id,
    });
    expect(response.status).toBe(
      fault === 'MAX_TOKENS'
        ? 'INCOMPLETE'
        : fault === 'SAFETY'
          ? 'REFUSED'
          : fault === 'MISSING_USAGE'
            ? 'OK'
            : 'TEMPORARY_FAILURE',
    );
    if (fault === 'MISSING_USAGE')
      expect(response.usage).toEqual({
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
      });
  },
);
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
    [408, 'TEMPORARY_FAILURE'],
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
it('distinguishes transport deadline from network failure without retrying or exposing details', async () => {
  for (const [name, reason] of [
    ['TimeoutError', 'TRANSPORT_TIMEOUT'],
    ['TypeError', 'TRANSPORT_FAILURE'],
  ] as const) {
    let submissions = 0;
    let calls = 0;
    const provider = new GeminiFreeProvider(
      'fixture-private-key',
      async () => {
        submissions++;
      },
      async () => {
        calls++;
        const error = new Error('private source and fixture-private-key');
        error.name = name;
        throw error;
      },
      () => now,
    );
    const result = await provider.run(request, {
      reservation_id: 'reserved',
      request_id: request.request_id,
    });
    expect(result).toMatchObject({
      status: 'TEMPORARY_FAILURE',
      finish_reason: reason,
      raw_output: null,
      usage: { input_tokens: null, output_tokens: null, total_tokens: null },
    });
    expect(submissions).toBe(1);
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain('private');
  }
});
it('retains bounded official error categories without error messages or hidden retries', async () => {
  for (const [body, reason] of [
    [
      JSON.stringify({
        error: {
          code: 'service_unavailable',
          message: 'secret fixture-private-key',
        },
      }),
      'HTTP_503:service_unavailable',
    ],
    [
      JSON.stringify({
        error: { code: 'fixture-private-key', message: 'secret' },
      }),
      'HTTP_503',
    ],
    [
      JSON.stringify({
        error: { code: 'service_unavailable', message: 'x'.repeat(5000) },
      }),
      'HTTP_503',
    ],
    ['private invalid json', 'HTTP_503'],
  ] as const) {
    let calls = 0;
    const adapter = new GeminiFreeProvider(
      'fixture-private-key',
      async () => {},
      async () => {
        calls++;
        return new Response(body, { status: 503 });
      },
      () => now,
    );
    const result = await adapter.run(request, {
      reservation_id: 'x',
      request_id: request.request_id,
    });
    expect(result.finish_reason).toBe(reason);
    expect(result.status).toBe('TEMPORARY_FAILURE');
    expect(result.usage.input_tokens).toBeNull();
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain('fixture-private-key');
    expect(JSON.stringify(result)).not.toContain('message');
  }
});
it('keeps only a matching fixed Google RPC error status, with unknown usage and no retry', async () => {
  for (const [http, code, status, expected] of [
    [400, 400, 'INVALID_ARGUMENT', 'HTTP_400:INVALID_ARGUMENT'],
    [503, 503, 'UNAVAILABLE', 'HTTP_503:UNAVAILABLE'],
    [400, 503, 'INVALID_ARGUMENT', 'HTTP_400'],
    [400, 400, 'private-echo', 'HTTP_400'],
    [400, '400', 'INVALID_ARGUMENT', 'HTTP_400'],
  ] as const) {
    let calls = 0;
    const adapter = new GeminiFreeProvider(
      'fixture-private-key',
      async () => {},
      async () => {
        calls++;
        return new Response(
          JSON.stringify({
            error: {
              code,
              status,
              message: 'fixture-private-key echoed source',
              details: [{ field: 'private source' }],
            },
          }),
          { status: http },
        );
      },
      () => now,
      'generateContent',
    );
    const result = await adapter.run(
      { ...request, mode: 'QUALITY_TEST' },
      {
        reservation_id: 'reserved',
        request_id: request.request_id,
      },
    );
    expect(result.finish_reason).toBe(expected);
    expect(result.raw_output).toBeNull();
    expect(result.usage.input_tokens).toBeNull();
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain('private');
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
