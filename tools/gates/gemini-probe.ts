import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  guardedFetch,
  loadConfig,
  ProviderRegistry,
} from '../../packages/core/src/config/index.js';
import type { ProviderDescriptor } from '../../packages/contracts/src/config.js';
import defaults from '../../config/defaults.json' with { type: 'json' };

const directory = 'docs/verification/gate-e';
if (existsSync(`${directory}/gemini-probe-reservation.json`))
  throw new Error('GEMINI_PROBE_ALREADY_RESERVED');
const decision = JSON.parse(
  readFileSync(`${directory}/owner-use-decision.json`, 'utf8'),
);
const dashboard = JSON.parse(
  readFileSync(`${directory}/dashboard-observations.json`, 'utf8'),
);
const now = Date.now();
if (
  decision.owner_use_classification !== 'professional_single_owner' ||
  decision.developer_is_only_user !== true ||
  decision.public_or_other_user_distribution !== false ||
  decision.billing_route !== 'disabled' ||
  decision.paid_services_enabled !== false ||
  dashboard.google.billing !== 'DISABLED' ||
  dashboard.gemini.tier !== 'Free tier' ||
  process.env.GOOGLE_PROJECT_ID !== decision.google_project ||
  !process.env.GEMINI_API_KEY ||
  now - Date.parse(dashboard.sampled_at) > 3600000 ||
  now < Date.parse(dashboard.sampled_at)
)
  throw new Error('GEMINI_PROBE_PREREQUISITE_DENIED');
const model = 'gemini-3.8-flash';
const descriptor: ProviderDescriptor = {
  id: 'gemini',
  version: 'rest-v1beta-probe-1',
  runtime: 'node',
  kind: 'ai',
  enabled: true,
  health: 'AVAILABLE',
  eligibility: 'VERIFIED_FREE',
  eligibility_ref: `${directory}/owner-use-decision.json`,
  evidence_version: 'rest-v1beta-probe-1',
  evidence_runtime: 'node',
  expires_at: new Date(
    Date.parse(dashboard.sampled_at) + 3600000,
  ).toISOString(),
  measurement_ref: null,
  optional: null,
  billing: 'free',
  autopurchase: false,
  approved_models: [model],
  capabilities: ['text', 'json-probe'],
  allowed_origins: ['https://generativelanguage.googleapis.com'],
};
// Isolated bounded qualification policy; production config stays disabled until success.
const registry = new ProviderRegistry([descriptor]);
const policy = loadConfig({ ...defaults, ai_provider: 'gemini' }, registry);
const headers = {
  'x-goog-api-key': process.env.GEMINI_API_KEY,
  'Content-Type': 'application/json',
};
const sampled_at = new Date().toISOString();
const request = {
  contents: [
    {
      parts: [
        {
          text: 'Return a JSON object with ok set to true. This is a synthetic API availability test.',
        },
      ],
    },
  ],
  generationConfig: {
    maxOutputTokens: 64,
    temperature: 0,
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'OBJECT',
      properties: { ok: { type: 'BOOLEAN' } },
      required: ['ok'],
    },
  },
};
let submissions = 0;
let http_status: number | null = null;
let models_http_status: number | null = null;
let capability_observed = false;
let structured_output_valid = false;
let usage: unknown = null;
let response_diagnostic: unknown = null;
let reason = 'UNAVAILABLE';
const started = performance.now();
try {
  const modelsResponse = await guardedFetch(
    policy,
    registry,
    'gemini',
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100',
    { headers, signal: AbortSignal.timeout(20000) },
    model,
  );
  models_http_status = modelsResponse.status;
  const models = (await modelsResponse.json()) as {
    models?: { name: string; supportedGenerationMethods?: string[] }[];
  };
  capability_observed =
    modelsResponse.ok &&
    models.models?.some(
      (row) =>
        row.name === `models/${model}` &&
        row.supportedGenerationMethods?.includes('generateContent'),
    ) === true;
  if (!capability_observed) reason = 'MODEL_ACCESS_NOT_ESTABLISHED';
  else {
    const observed = dashboard.gemini.models.find(
      (row: { api_id?: string }) => row.api_id === model,
    );
    if (
      !observed ||
      observed.rpm < 1 ||
      observed.rpd < 1 ||
      observed.input_tpm < 100
    ) {
      reason = 'GEMINI_PROBE_ALLOWANCE_UNKNOWN';
    } else {
      writeFileSync(
        `${directory}/gemini-probe-reservation.json`,
        JSON.stringify(
          {
            sampled_at,
            model,
            generation_requests: 1,
            max_output_tokens: 64,
            status: 'RESERVED',
            remaining_quota: null,
            basis:
              'Master §14 permits one cautious verified-Free no-billing probe with unknown remaining quota',
          },
          null,
          2,
        ),
        { flag: 'wx' },
      );
      submissions++;
      const response = await guardedFetch(
        policy,
        registry,
        'gemini',
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(30000),
        },
        model,
      );
      http_status = response.status;
      const data = (await response.json()) as {
        candidates?: {
          content?: { parts?: { text?: string }[] };
          finishReason?: string;
        }[];
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
        };
        error?: { status?: string };
      };
      response_diagnostic = {
        candidate_count: data.candidates?.length ?? 0,
        finish_reason: data.candidates?.[0]?.finishReason ?? null,
        text_present: Boolean(
          data.candidates?.[0]?.content?.parts?.some(
            (part) => typeof part.text === 'string' && part.text.length > 0,
          ),
        ),
        usage_present: Boolean(data.usageMetadata),
      };
      if (response.ok) {
        const text =
          data.candidates?.[0]?.content?.parts
            ?.map((part) => part.text ?? '')
            .join('') ?? '';
        const parsed = JSON.parse(text);
        structured_output_valid =
          parsed.ok === true &&
          Object.keys(parsed).length === 1 &&
          data.candidates?.[0]?.finishReason === 'STOP';
        usage = {
          prompt_tokens: data.usageMetadata?.promptTokenCount ?? null,
          output_tokens: data.usageMetadata?.candidatesTokenCount ?? null,
          total_tokens: data.usageMetadata?.totalTokenCount ?? null,
        };
        reason = structured_output_valid
          ? 'QUALIFIED_MINIMAL_PROBE'
          : 'STRUCTURED_OUTPUT_INVALID';
      } else
        reason =
          http_status === 429
            ? 'QUOTA_DENIED'
            : (data.error?.status ?? 'REQUEST_FAILED');
    }
  }
} catch {
  reason =
    http_status === 200
      ? 'HTTP_200_RESPONSE_PARSE_FAILURE_DIAGNOSTIC_NOT_CAPTURED'
      : 'TRANSPORT_OR_RESPONSE_FAILURE';
}
const report = {
  sampled_at,
  model,
  runtime: `node-${process.versions.node}`,
  harness_version: descriptor.version,
  owner_use_classification: decision.owner_use_classification,
  classification_ref: `${directory}/owner-use-decision.json`,
  billing_route: 'disabled',
  paid_services_enabled: false,
  probe_budget: {
    generation_requests: 1,
    max_output_tokens: 64,
    retries: 0,
    tools: false,
    grounding: false,
  },
  models_http_status,
  capability_observed,
  generation_submissions: submissions,
  http_status,
  structured_output_valid,
  response_diagnostic,
  usage,
  latency_ms: Math.round(performance.now() - started),
  cpu_platform_ms: null,
  request_sha256: createHash('sha256')
    .update(JSON.stringify(request))
    .digest('hex'),
  result: structured_output_valid ? 'PASS' : 'FAIL',
  reason,
};
const output = `${JSON.stringify(report, null, 2)}\n`;
for (const key of [
  'GEMINI_API_KEY',
  'YOUTUBE_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
])
  if (process.env[key] && output.includes(process.env[key]!))
    throw new Error('SECRET_IN_EVIDENCE_DENIED');
writeFileSync(`${directory}/gemini-probe.json`, output);
if (existsSync(`${directory}/gemini-probe-reservation.json`))
  writeFileSync(
    `${directory}/gemini-probe-reservation.json`,
    `${JSON.stringify({ sampled_at, model, generation_requests: 1, max_output_tokens: 64, status: http_status === null ? 'AMBIGUOUS' : 'SETTLED', http_status, usage }, null, 2)}\n`,
  );
console.log(
  JSON.stringify({
    result: report.result,
    http_status,
    models_http_status,
    generation_submissions: submissions,
    structured_output_valid,
    reason,
  }),
);
if (report.result !== 'PASS') process.exitCode = 2;
