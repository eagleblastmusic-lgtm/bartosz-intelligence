export type GeminiEndpoint = 'generateContent' | 'interactions';

export interface GeminiProbeResponse {
  http_status: number;
  content_type: string | null;
  json_valid: boolean;
  json_shape: Record<string, unknown>;
  finish_reason: string | null;
  model_identifier: string | null;
  token_usage: Record<string, number | null> | null;
  token_usage_numeric_fields: Record<string, number> | null;
  structured_output_valid: boolean;
  failure_reason: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function parseGeminiProbeResponse(
  endpoint: GeminiEndpoint,
  httpStatus: number,
  contentType: string | null,
  payload: unknown,
): GeminiProbeResponse {
  const jsonValid = isRecord(payload);
  const root = jsonValid ? payload : {};
  const shape: Record<string, unknown> = {
    top_level_keys: Object.keys(root).sort(),
  };
  let text = '';
  let finishReason: string | null = null;
  let modelIdentifier: string | null = null;
  let usage: Record<string, number | null> | null = null;
  let usageNumericFields: Record<string, number> | null = null;

  if (endpoint === 'generateContent') {
    const candidates = Array.isArray(root.candidates) ? root.candidates : [];
    const first = isRecord(candidates[0]) ? candidates[0] : {};
    const content = isRecord(first.content) ? first.content : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const tokenUsage = isRecord(root.usageMetadata) ? root.usageMetadata : null;
    shape.candidate_count = candidates.length;
    shape.candidate_keys = Object.keys(first).sort();
    shape.content_keys = Object.keys(content).sort();
    shape.part_types = parts.map((part: unknown) =>
      isRecord(part) ? Object.keys(part).sort() : typeof part,
    );
    shape.usage_keys = tokenUsage ? Object.keys(tokenUsage).sort() : [];
    text = parts
      .filter(
        (part: unknown) => isRecord(part) && typeof part.text === 'string',
      )
      .map((part: Record<string, unknown>) => part.text)
      .join('');
    finishReason =
      typeof first.finishReason === 'string' ? first.finishReason : null;
    modelIdentifier =
      typeof root.modelVersion === 'string' ? root.modelVersion : null;
    usage = tokenUsage
      ? {
          input_tokens: finite(tokenUsage.promptTokenCount),
          output_tokens: finite(tokenUsage.candidatesTokenCount),
          total_tokens: finite(tokenUsage.totalTokenCount),
        }
      : null;
    usageNumericFields = tokenUsage ? numericLeaves(tokenUsage) : null;
  } else {
    const steps = Array.isArray(root.steps) ? root.steps : [];
    const modelOutputs = steps.filter(
      (step: unknown) => isRecord(step) && step.type === 'model_output',
    );
    const content = modelOutputs.flatMap((step: Record<string, unknown>) =>
      Array.isArray(step.content) ? step.content : [],
    );
    shape.step_types = steps.map((step: unknown) =>
      isRecord(step) ? (step.type ?? 'unknown') : typeof step,
    );
    shape.output_content_types = content.map((item: unknown) =>
      isRecord(item) ? (item.type ?? 'unknown') : typeof item,
    );
    shape.usage_keys = isRecord(root.usage)
      ? Object.keys(root.usage).sort()
      : [];
    text = content
      .filter(
        (item: unknown) =>
          isRecord(item) &&
          item.type === 'text' &&
          typeof item.text === 'string',
      )
      .map((item: Record<string, unknown>) => item.text)
      .join('');
    finishReason = typeof root.status === 'string' ? root.status : null;
    modelIdentifier = typeof root.model === 'string' ? root.model : null;
    const tokenUsage = isRecord(root.usage) ? root.usage : null;
    usage = tokenUsage
      ? {
          input_tokens: finite(tokenUsage.total_input_tokens),
          output_tokens: finite(tokenUsage.total_output_tokens),
          total_tokens: finite(tokenUsage.total_tokens),
        }
      : null;
    usageNumericFields = tokenUsage ? numericLeaves(tokenUsage) : null;
  }

  let structuredOutputValid = false;
  let failureReason: string | null = null;
  if (httpStatus !== 200) failureReason = `HTTP_${httpStatus}`;
  else if (!contentType?.toLowerCase().includes('application/json'))
    failureReason = 'CONTENT_TYPE_NOT_JSON';
  else if (!jsonValid) failureReason = 'RESPONSE_JSON_INVALID';
  else if (endpoint === 'generateContent' && finishReason !== 'STOP')
    failureReason = 'GENERATE_CONTENT_FINISH_REASON_INVALID';
  else if (endpoint === 'interactions' && finishReason === 'incomplete')
    failureReason = 'INTERACTION_INCOMPLETE_OUTPUT_BUDGET';
  else if (endpoint === 'interactions' && finishReason !== 'completed')
    failureReason = 'INTERACTION_STATUS_NOT_COMPLETED';
  else if (!text) failureReason = 'RESPONSE_TEXT_MISSING';
  else {
    try {
      const value: unknown = JSON.parse(text);
      structuredOutputValid =
        isRecord(value) && value.ok === true && Object.keys(value).length === 1;
      if (!structuredOutputValid)
        failureReason = 'STRUCTURED_OUTPUT_SCHEMA_INVALID';
    } catch {
      failureReason = 'STRUCTURED_OUTPUT_JSON_INVALID';
    }
  }

  return {
    http_status: httpStatus,
    content_type: contentType,
    json_valid: jsonValid,
    json_shape: shape,
    finish_reason: finishReason,
    model_identifier: modelIdentifier,
    token_usage: usage,
    token_usage_numeric_fields: usageNumericFields,
    structured_output_valid: structuredOutputValid,
    failure_reason: failureReason,
  };
}

function numericLeaves(value: unknown, prefix = ''): Record<string, number> {
  const fields: Record<string, number> = {};
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    fields[prefix || 'value'] = value;
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      Object.assign(fields, numericLeaves(item, `${prefix}[${index}]`));
    });
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      Object.assign(fields, numericLeaves(item, path));
    }
  }
  return fields;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
