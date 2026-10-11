import type {
  AIProvider,
  AIRequest,
  AIResponse,
} from '../../../contracts/src/ai.js';
import { materializeProviderSchema } from '../registry/bundle.js';
import { fetchWithoutRedirect } from '../http/no-redirect.js';
import { extractTokenAccounting } from './accounting.js';
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
async function providerErrorCode(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4096) return null;
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const error = record(
      record(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
            bytes,
          ),
        ),
      ).error,
    );
    // Only official fixed machine categories survive. Messages, details and
    // arbitrary strings may contain echoed input or credentials and are dropped.
    const allowed: Record<number, string[]> = {
      400: ['invalid_request', 'failed_precondition', 'parameter_unknown'],
      401: ['authentication'],
      403: ['permission_denied'],
      404: ['not_found', 'model_not_found'],
      429: ['rate_limit_exceeded', 'quota_exceeded', 'too_many_requests'],
      500: ['api_error'],
      501: ['unimplemented'],
      503: ['service_unavailable'],
      504: ['deadline_exceeded'],
    };
    if (
      typeof error.code === 'string' &&
      allowed[response.status]?.includes(error.code)
    )
      return error.code;
    // generateContent uses Google RPC's numeric HTTP code and fixed status enum.
    // Keep the same bounded diagnostic contract, never the echoed message/details.
    const rpcAllowed: Record<number, string[]> = {
      400: ['INVALID_ARGUMENT', 'FAILED_PRECONDITION', 'OUT_OF_RANGE'],
      401: ['UNAUTHENTICATED'],
      403: ['PERMISSION_DENIED'],
      404: ['NOT_FOUND'],
      429: ['RESOURCE_EXHAUSTED'],
      500: ['INTERNAL', 'UNKNOWN'],
      501: ['UNIMPLEMENTED'],
      503: ['UNAVAILABLE'],
      504: ['DEADLINE_EXCEEDED'],
    };
    return error.code === response.status &&
      typeof error.status === 'string' &&
      rpcAllowed[response.status]?.includes(error.status)
      ? error.status
      : null;
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export class GeminiFreeProvider implements AIProvider {
  readonly provider_id = 'gemini';
  constructor(
    private key: string,
    private consumePermit: (
      permit: { reservation_id: string; request_id: string },
      request: AIRequest,
    ) => Promise<void>,
    private transport: typeof fetch = fetch,
    private clock: () => Date = () => new Date(),
    private endpoint: 'interactions' | 'generateContent' = 'interactions',
  ) {}
  async run(
    request: AIRequest,
    permit: { reservation_id: string; request_id: string },
  ): Promise<AIResponse> {
    const profile = request.profile,
      now = this.clock();
    if (
      !['interactions', 'generateContent'].includes(this.endpoint) ||
      (this.endpoint === 'generateContent' && request.mode !== 'QUALITY_TEST')
    )
      throw new Error('DIAGNOSTIC_ENDPOINT_SCOPE_DENIED');
    if (
      request.paid_services_enabled !== false ||
      profile.billing_enabled ||
      !profile.free_eligible ||
      profile.profile_id !== 'gemini_free' ||
      profile.provider_id !== 'gemini'
    )
      throw new Error('PAID_OR_UNQUALIFIED_ROUTE_DENIED');
    if (
      permit.request_id !== request.request_id ||
      !permit.reservation_id ||
      !profile.runtimes.includes(request.runtime) ||
      Date.parse(profile.eligibility_expires_at) <= now.getTime() ||
      !Number.isFinite(Date.parse(profile.eligibility_expires_at)) ||
      (request.mode === 'PRODUCTION' &&
        !profile.quality_approvals.includes(request.quality_scope)) ||
      !Number.isSafeInteger(request.estimated_input_tokens) ||
      request.estimated_input_tokens < 1 ||
      !Number.isSafeInteger(request.max_output_tokens) ||
      request.max_output_tokens < 1 ||
      request.max_output_tokens > profile.output_tokens ||
      request.estimated_input_tokens + request.max_output_tokens >
        profile.context_tokens ||
      !profile.structured_output
    )
      throw new Error('AI_ADMISSION_DENIED');
    const timeout = Date.parse(request.deadline) - now.getTime();
    if (
      !Number.isFinite(timeout) ||
      timeout <= 0 ||
      timeout > 300000 ||
      !this.key ||
      !/^gemini-[a-z0-9.-]+$/.test(profile.model)
    )
      throw new Error('INVALID_AI_REQUEST');
    if (
      request.wire_schema.$id !== 'urn:bartosz:schema:economy-wire:1.0' &&
      request.wire_schema.$id !== 'urn:bartosz:schema:repair-wire:1.0' &&
      request.wire_schema.$id !== 'urn:bartosz:schema:full-wire:1.0' &&
      request.wire_schema.$id !== 'urn:bartosz:schema:translation-wire:1.0' &&
      request.wire_schema.$id !== 'urn:bartosz:schema:history-wire:1.0' &&
      !(
        typeof request.wire_schema.$id === 'string' &&
        /^urn:bartosz:schema:custom-wire:[a-f0-9]{64}:1\.0$/.test(
          request.wire_schema.$id,
        )
      )
    )
      throw new Error('UNSUPPORTED_WIRE_SCHEMA');
    const body =
      this.endpoint === 'generateContent'
        ? {
            contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
            generationConfig: {
              responseFormat: {
                text: {
                  mimeType: 'APPLICATION_JSON',
                  schema: materializeProviderSchema(request.wire_schema),
                },
              },
              maxOutputTokens: request.max_output_tokens,
              thinkingConfig: { thinkingLevel: 'LOW' },
            },
          }
        : {
            model: profile.model,
            input: request.prompt,
            store: false,
            response_format: {
              type: 'text',
              mime_type: 'application/json',
              schema: materializeProviderSchema(request.wire_schema),
            },
            generation_config: {
              thinking_level: 'low',
              max_output_tokens: request.max_output_tokens,
            },
          };
    await this.consumePermit(permit, request);
    const base: AIResponse = {
      request_id: request.request_id,
      status: 'TEMPORARY_FAILURE',
      raw_output: null,
      actual_provider: 'gemini',
      actual_model: null,
      finish_reason: 'TRANSPORT_FAILURE',
      usage: { input_tokens: null, output_tokens: null, total_tokens: null },
      retry_after: null,
      token_usage_numeric_fields: null,
    };
    try {
      const response = await fetchWithoutRedirect(
        this.endpoint === 'generateContent'
          ? `https://generativelanguage.googleapis.com/v1beta/models/${profile.model}:generateContent`
          : 'https://generativelanguage.googleapis.com/v1beta/interactions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.key,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        },
        this.transport,
      );
      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        let retryAfter: string | null = null;
        if (retry && retry.length <= 64) {
          const at = /^\d{1,7}$/.test(retry)
            ? this.clock().getTime() + Number(retry) * 1000
            : Date.parse(retry);
          if (Number.isFinite(at) && at > this.clock().getTime())
            retryAfter = new Date(at).toISOString();
        }
        const code = await providerErrorCode(response);
        return {
          ...base,
          status:
            response.status === 429
              ? 'RATE_LIMITED'
              : [401, 403].includes(response.status)
                ? 'AUTH_REQUIRED'
                : response.status === 408 || response.status >= 500
                  ? 'TEMPORARY_FAILURE'
                  : 'INVALID_REQUEST',
          finish_reason: `HTTP_${response.status}` + (code ? ':' + code : ''),
          retry_after: retryAfter,
        };
      }
      if (!response.headers.get('content-type')?.includes('application/json')) {
        await response.body?.cancel();
        return { ...base, finish_reason: 'INVALID_RESPONSE_TYPE' };
      }
      const reader = response.body?.getReader();
      if (!reader) return { ...base, finish_reason: 'EMPTY_RESPONSE' };
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          return { ...base, finish_reason: 'RESPONSE_TOO_LARGE' };
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const root = record(
          JSON.parse(
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
              bytes,
            ),
          ),
        ),
        usage = record(root.usage);
      if (this.endpoint === 'generateContent') {
        const candidates = Array.isArray(root.candidates)
          ? root.candidates
          : [];
        const candidate = record(candidates[0]);
        const parts = Array.isArray(record(candidate.content).parts)
          ? (record(candidate.content).parts as unknown[])
          : [];
        const text = parts
          .filter(
            (part) =>
              record(part).thought !== true &&
              typeof record(part).text === 'string',
          )
          .map((part) => record(part).text)
          .join('');
        const finish =
          typeof candidate.finishReason === 'string'
            ? candidate.finishReason
            : 'UNKNOWN_FINISH';
        const refused =
          ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(
            finish,
          ) || typeof record(root.promptFeedback).blockReason === 'string';
        const model =
          typeof root.modelVersion === 'string' &&
          /^gemini-[a-z0-9.-]+$/.test(root.modelVersion)
            ? root.modelVersion
            : null;
        const observed = record(root.usageMetadata);
        const accounting = {
          total_input_tokens: observed.promptTokenCount,
          total_output_tokens: observed.candidatesTokenCount,
          total_tokens: observed.totalTokenCount,
          total_thought_tokens: observed.thoughtsTokenCount,
          total_cached_tokens: observed.cachedContentTokenCount,
        };
        const toolOutput = parts.some(
          (part) => record(part).functionCall !== undefined,
        );
        return {
          ...base,
          status: refused
            ? 'REFUSED'
            : finish === 'MAX_TOKENS'
              ? 'INCOMPLETE'
              : finish === 'STOP' &&
                  candidates.length === 1 &&
                  text &&
                  model === profile.model &&
                  !toolOutput
                ? 'OK'
                : 'TEMPORARY_FAILURE',
          raw_output: text || null,
          actual_model: model,
          finish_reason: refused
            ? 'REFUSAL'
            : toolOutput
              ? 'TOOL_OUTPUT_REFUSED'
              : finish,
          usage: {
            input_tokens: count(observed.promptTokenCount),
            output_tokens: count(observed.candidatesTokenCount),
            total_tokens: count(observed.totalTokenCount),
          },
          token_usage_numeric_fields: extractTokenAccounting(accounting),
        };
      }
      const steps = Array.isArray(root.steps) ? root.steps : [];
      const contents = steps
        .filter((value) => record(value).type === 'model_output')
        .flatMap((value) =>
          Array.isArray(record(value).content)
            ? (record(value).content as unknown[])
            : [],
        );
      const refusal = contents.some(
        (value) => record(value).type === 'refusal',
      );
      const text = contents
        .filter(
          (value) =>
            record(value).type === 'text' &&
            typeof record(value).text === 'string',
        )
        .map((value) => record(value).text)
        .join('');
      const model =
        typeof root.model === 'string' &&
        /^gemini-[a-z0-9.-]+$/.test(root.model)
          ? root.model
          : null;
      const finish = [
        'completed',
        'incomplete',
        'failed',
        'cancelled',
      ].includes(String(root.status))
        ? String(root.status)
        : 'UNKNOWN_FINISH';
      return {
        ...base,
        status: refusal
          ? 'REFUSED'
          : finish === 'completed' && text && model === profile.model
            ? 'OK'
            : finish === 'incomplete'
              ? 'INCOMPLETE'
              : 'TEMPORARY_FAILURE',
        raw_output: text || null,
        actual_model: model,
        finish_reason: refusal ? 'REFUSAL' : finish,
        usage: {
          input_tokens: count(usage.total_input_tokens),
          output_tokens: count(usage.total_output_tokens),
          total_tokens: count(usage.total_tokens),
        },
        token_usage_numeric_fields: extractTokenAccounting(root.usage),
      };
    } catch (error) {
      // Retain only a fixed timeout category, never transport exception text.
      // Submission may already have reached Google; usage remains unknown.
      return {
        ...base,
        finish_reason:
          error instanceof Error && error.name === 'TimeoutError'
            ? 'TRANSPORT_TIMEOUT'
            : 'TRANSPORT_FAILURE',
      };
    }
  }
}
