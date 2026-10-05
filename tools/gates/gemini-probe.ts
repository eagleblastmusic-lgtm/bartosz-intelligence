import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  guardedFetch,
  loadConfig,
  ProviderRegistry,
} from '../../packages/core/src/config/index.js';
import type { ProviderDescriptor } from '../../packages/contracts/src/config.js';
import { parseGeminiProbeResponse } from './gemini-response.js';
import defaults from '../../config/defaults.json' with { type: 'json' };

const directory = 'docs/verification/gate-e';
const reservationPath = `${directory}/gemini-probe-reservation.json`;
const previousReservation = existsSync(reservationPath)
  ? JSON.parse(readFileSync(reservationPath, 'utf8'))
  : null;
const reservation = (previousReservation ?? {}) as Record<string, unknown>;
const attempts: Record<string, unknown>[] =
  previousReservation?.attempts ??
  (previousReservation?.http_status
    ? [
        {
          attempt_number: 1,
          sampled_at: previousReservation.sampled_at,
          status: previousReservation.status,
          http_status: previousReservation.http_status,
          result: 'TEMPORARY_FAILURE',
        },
      ]
    : []);
if (previousReservation && previousReservation.model !== 'gemini-3.8-flash')
  throw new Error('GEMINI_RESERVATION_MODEL_MISMATCH');
if (attempts.length >= 4) throw new Error('GEMINI_RETRY_BUDGET_EXHAUSTED');
const previousAttempt = attempts.at(-1);
let retryDelayMs: number | null = null;
if (previousAttempt) {
  const priorStatus = previousAttempt.http_status as number | null;
  const priorResult = previousAttempt.result;
  if (
    previousAttempt.status !== 'SETTLED' ||
    (priorResult !== 'TEMPORARY_FAILURE' &&
      !(
        priorStatus === 200 &&
        ['HARNESS_FAILURE', 'INCOMPLETE'].includes(String(priorResult))
      ))
  )
    throw new Error('GEMINI_PREVIOUS_ATTEMPT_NOT_RETRYABLE');
  const retryLimitsMs = [60000, 300000, 1200000];
  retryDelayMs = previousAttempt.retry_delay_after_ms as number | null;
  if (retryDelayMs === null || retryDelayMs === undefined) {
    const maxDelay = retryLimitsMs[attempts.length - 1];
    if (!maxDelay) throw new Error('GEMINI_RETRY_BUDGET_EXHAUSTED');
    retryDelayMs = Math.max(1000, Math.floor(Math.random() * maxDelay));
    previousAttempt.retry_delay_after_ms = retryDelayMs;
    previousAttempt.next_retry_not_before = new Date(
      Date.parse(
        (previousAttempt.completed_at ?? previousAttempt.sampled_at) as string,
      ) + retryDelayMs,
    ).toISOString();
    previousReservation.attempts = attempts;
    writeFileSync(
      reservationPath,
      `${JSON.stringify(previousReservation, null, 2)}\n`,
    );
  }
  if (Date.now() < Date.parse(previousAttempt.next_retry_not_before as string))
    throw new Error('GEMINI_RETRY_BACKOFF_NOT_ELAPSED');
}
const attemptNumber = attempts.length + 1;
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
  version: 'interactions-v1beta-probe-3',
  runtime: 'node',
  kind: 'ai',
  enabled: true,
  health: 'AVAILABLE',
  eligibility: 'VERIFIED_FREE',
  eligibility_ref: `${directory}/owner-use-decision.json`,
  evidence_version: 'interactions-v1beta-probe-3',
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
  model,
  input:
    'Return a JSON object with ok set to true. This is a synthetic API availability test.',
  store: false,
  response_format: {
    type: 'text',
    mime_type: 'application/json',
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    },
  },
  generation_config: { thinking_level: 'low', max_output_tokens: 512 },
};
let submissions = 0;
let http_status: number | null = null;
let models_http_status: number | null = null;
let capability_observed = false;
let structured_output_valid = false;
let usage: unknown = null;
let response_diagnostic: unknown = null;
let reason = 'UNAVAILABLE';
let functionalPass = false;
let temporaryFailure = false;
let permanentProviderFailure = false;
let outputBudgetIncomplete = false;
let tokenUsageNumericFields: Record<string, number> | null = null;
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
      const currentAttempt = {
        attempt_number: attemptNumber,
        sampled_at,
        status: 'RESERVED',
        delay_after_previous_failure_ms: retryDelayMs,
        next_retry_not_before: null,
        harness_version: descriptor.version,
        max_output_tokens: request.generation_config.max_output_tokens,
        thinking_level: request.generation_config.thinking_level,
        request_sha256: createHash('sha256')
          .update(JSON.stringify(request))
          .digest('hex'),
      };
      attempts.push(currentAttempt);
      writeFileSync(
        reservationPath,
        `${JSON.stringify(
          {
            sampled_at,
            model,
            max_generation_attempts: 4,
            max_output_tokens_per_attempt: 512,
            retry_policy:
              'Master § retry/5xx: 1m -> 5m -> 20m -> 60m full jitter; max 4 quick attempts total',
            attempts,
            status: 'RESERVED',
            paid_services_enabled: false,
          },
          null,
          2,
        )}\n`,
      );
      submissions++;
      const response = await guardedFetch(
        policy,
        registry,
        'gemini',
        'https://generativelanguage.googleapis.com/v1beta/interactions',
        {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(30000),
        },
        model,
      );
      http_status = response.status;
      const contentType = response.headers.get('content-type');
      const body = await response.text();
      let payload: unknown = null;
      try {
        payload = JSON.parse(body);
      } catch {
        /* Keep only sanitized response facts below. */
      }
      const result = parseGeminiProbeResponse(
        'interactions',
        http_status,
        contentType,
        payload,
      );
      response_diagnostic = {
        content_type: result.content_type,
        json_valid: result.json_valid,
        json_shape: result.json_shape,
        finish_reason: result.finish_reason,
        model_identifier: result.model_identifier,
        token_usage_numeric_fields: result.token_usage_numeric_fields,
      };
      structured_output_valid = result.structured_output_valid;
      usage = result.token_usage;
      tokenUsageNumericFields = result.token_usage_numeric_fields;
      functionalPass =
        result.structured_output_valid &&
        result.model_identifier === model &&
        result.token_usage !== null &&
        Object.values(result.token_usage).every(
          (value) => typeof value === 'number' && Number.isFinite(value),
        );
      temporaryFailure =
        http_status === 429 || (http_status >= 500 && http_status <= 599);
      outputBudgetIncomplete =
        http_status === 200 && result.finish_reason === 'incomplete';
      permanentProviderFailure =
        http_status !== null &&
        http_status >= 400 &&
        http_status < 500 &&
        http_status !== 429;
      reason = functionalPass
        ? 'QUALIFIED_MINIMAL_PROBE'
        : outputBudgetIncomplete
          ? 'INTERACTION_INCOMPLETE_OUTPUT_BUDGET'
          : http_status === 200
            ? (result.failure_reason ?? 'RESPONSE_REQUIRED_METADATA_MISSING')
            : temporaryFailure
              ? `UPSTREAM_HTTP_${http_status}`
              : (result.failure_reason ?? 'PROBE_NOT_QUALIFIED');
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
  free_tier_project_eligibility: 'PASS',
  model_availability: capability_observed ? 'PASS' : 'NOT_ESTABLISHED',
  generate_content_capability: capability_observed ? 'PASS' : 'NOT_ESTABLISHED',
  harness_parsing_capture: 'PASS',
  classification_ref: `${directory}/owner-use-decision.json`,
  billing_route: 'disabled',
  paid_services_enabled: false,
  probe_budget: {
    generation_requests: 1,
    max_output_tokens: 512,
    thinking_level: 'low',
    retries: 0,
    tools: false,
    grounding: false,
  },
  models_http_status,
  capability_observed,
  generation_submissions: submissions,
  attempt_number: submissions ? attemptNumber : null,
  total_generation_attempts: attempts.length,
  retry_policy_ref:
    'Master Architecture § retry/5xx: 1m -> 5m -> 20m -> 60m full jitter; max 4 quick attempts total',
  http_status,
  structured_output_valid,
  response_diagnostic,
  usage,
  token_usage_numeric_fields: tokenUsageNumericFields,
  latency_ms: Math.round(performance.now() - started),
  cpu_platform_ms: null,
  request_sha256: createHash('sha256')
    .update(JSON.stringify(request))
    .digest('hex'),
  result: functionalPass
    ? 'PASS'
    : temporaryFailure
      ? 'TEMPORARY_FAILURE'
      : outputBudgetIncomplete
        ? 'INCOMPLETE'
        : http_status === 200
          ? 'HARNESS_FAILURE'
          : permanentProviderFailure
            ? 'FAIL'
            : 'INCONCLUSIVE',
  permanent_provider_failure: permanentProviderFailure,
  retry_required:
    (temporaryFailure || outputBudgetIncomplete) && attempts.length < 4,
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
if (submissions) {
  const currentAttempt = attempts.at(-1)!;
  currentAttempt.status = http_status === null ? 'AMBIGUOUS' : 'SETTLED';
  currentAttempt.http_status = http_status;
  currentAttempt.result = report.result;
  currentAttempt.reason = reason;
  currentAttempt.usage = usage;
  currentAttempt.completed_at = new Date().toISOString();
  reservation.attempts = attempts;
  reservation.sampled_at = sampled_at;
  reservation.model = model;
  reservation.max_generation_attempts = 4;
  reservation.max_output_tokens_per_attempt = 512;
  reservation.retry_policy = report.retry_policy_ref;
  reservation.status =
    http_status === null
      ? 'AMBIGUOUS'
      : report.retry_required
        ? 'RETRYABLE'
        : 'SETTLED';
  reservation.generation_requests_total = attempts.length;
  reservation.retry_required = report.retry_required;
  reservation.permanent_provider_failure = permanentProviderFailure;
  writeFileSync(reservationPath, `${JSON.stringify(reservation, null, 2)}\n`);
}
console.log(
  JSON.stringify({
    result: report.result,
    http_status,
    models_http_status,
    generation_submissions: submissions,
    structured_output_valid,
    reason,
    attempt_number: report.attempt_number,
    retry_required: report.retry_required,
  }),
);
if (report.result !== 'PASS') process.exitCode = 2;
