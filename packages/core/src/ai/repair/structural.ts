import { sha256 } from '../../auth/crypto.js';
import { renderPrompt } from '../../registry/bundle.js';
import type { PromptSnapshot } from '../../registry/store.js';
import type { AIRequest, AIResponse } from '../../../../contracts/src/ai.js';
import { strictJson } from './strict-json.js';
import {
  validateEconomyCandidate,
  validateSemanticCandidate,
  validateRepairWire,
} from './validate.js';
import type { MaterializedSemanticProfile } from '../../registry/semantic-profiles.js';

// This class has a complete, unambiguous semantic reference. Removing trailing
// delimiters is intentionally outside DR1–DR4 and never accepts a main output.
// Other malformed classes stay disabled until measured and safely classified.
function trailingCommaReference(raw: string) {
  let quoted = false,
    escaped = false,
    changed = false,
    reference = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quoted) {
      reference += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      reference += c;
    } else if (c === ',' && /^[ \t\r\n]*[}\]]/.test(raw.slice(i + 1)))
      changed = true;
    else reference += c;
  }
  if (!changed || quoted) throw new Error('NO_SAFE_STRUCTURAL_REPAIR');
  strictJson(reference); // Still rejects duplicates, extra roots and truncation.
  return reference;
}
function semanticTree(value: unknown): string {
  if (Array.isArray(value))
    return '[' + value.map(semanticTree).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => JSON.stringify(key) + ':' + semanticTree(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export async function compileStructuralRepair(input: {
  raw: string;
  completion: AIResponse['status'];
  prompt: PromptSnapshot;
  main: AIRequest;
  request_id: string;
  deadline: string;
  aliases: ReadonlySet<string>;
  semantic_profile?: MaterializedSemanticProfile;
  measurement: { error_class: 'TRAILING_COMMA'; evidence_hash: string } | null;
}) {
  if (
    input.completion !== 'OK' ||
    !input.measurement ||
    input.measurement.error_class !== 'TRAILING_COMMA' ||
    !Number.isSafeInteger(input.main.estimated_input_tokens) ||
    input.main.estimated_input_tokens < 1 ||
    !Number.isSafeInteger(input.main.max_output_tokens) ||
    input.main.max_output_tokens < 1 ||
    !/^[a-f0-9]{64}$/.test(input.measurement.evidence_hash)
  )
    throw new Error('REPAIR_NOT_ADMITTED');
  const reference = trailingCommaReference(input.raw);
  if (
    input.semantic_profile &&
    (await sha256(JSON.stringify(input.main.wire_schema))) !==
      input.semantic_profile.wire.hash
  )
    throw new Error('REPAIR_SCHEMA_MISMATCH');
  const checked = input.semantic_profile
    ? await validateSemanticCandidate(
        reference,
        'OK',
        input.aliases,
        input.semantic_profile,
      )
    : await validateEconomyCandidate(reference, 'OK', input.aliases);
  if (!checked.valid) throw new Error('SEMANTIC_ERROR_NOT_REPAIRABLE');
  const prompt = input.prompt;
  if (
    prompt.prompt_id !== 'JSON_REPAIR_V1' ||
    prompt.version !== 2 ||
    prompt.wire.id !== 'urn:bartosz:schema:repair-wire:1.0' ||
    prompt.canonical.id !== 'urn:bartosz:schema:repair-envelope:1.1' ||
    (await sha256(prompt.text)) !== prompt.prompt_hash ||
    (await sha256(JSON.stringify(prompt.wire.schema))) !== prompt.wire.hash ||
    (await sha256(JSON.stringify(prompt.canonical.schema))) !==
      prompt.canonical.hash
  )
    throw new Error('INCOMPATIBLE_REPAIR_PROMPT');
  const text = renderPrompt(prompt.text, {
    repair_wire_schema_json: JSON.stringify(prompt.wire.schema),
    expected_wire_schema_json: JSON.stringify(input.main.wire_schema),
    deterministic_repair_report_json: JSON.stringify({
      result: 'NO_SAFE_REPAIR',
      raw_hash: await sha256(input.raw),
      rules: 'DR1–DR4:1.0',
    }),
    validation_errors_json: JSON.stringify([{ error_class: 'TRAILING_COMMA' }]),
    raw_candidate_json_string: JSON.stringify(input.raw),
    referenced_source_segments_json_or_empty: '[]',
  });
  const inputTokens = new TextEncoder().encode(text).length;
  const outputTokens = Math.min(
    input.main.profile.output_tokens,
    new TextEncoder().encode(JSON.stringify(input.raw)).length + 512,
  );
  const estimate = inputTokens + outputTokens;
  const fullEstimate =
    input.main.estimated_input_tokens + input.main.max_output_tokens;
  if (
    estimate > 0.35 * fullEstimate ||
    estimate > input.main.profile.context_tokens
  )
    throw new Error('REPAIR_COST_NOT_ADMITTED');
  const request: AIRequest = {
    ...structuredClone(input.main),
    request_id: input.request_id,
    deadline: input.deadline,
    prompt: text,
    wire_schema: structuredClone(prompt.wire.schema),
    estimated_input_tokens: inputTokens,
    max_output_tokens: outputTokens,
    quality_scope: await sha256(
      JSON.stringify({
        main_scope: input.main.quality_scope,
        repair_prompt: prompt.prompt_hash,
        repair_wire: prompt.wire.hash,
        measurement: input.measurement.evidence_hash,
      }),
    ),
  };
  return {
    request,
    reference,
    admission: {
      estimated_repair_tokens: estimate,
      estimated_full_retry_tokens: fullEstimate,
      error_class: input.measurement.error_class,
      measurement_hash: input.measurement.evidence_hash,
    },
    prompt_snapshot: structuredClone(prompt),
  };
}
export async function validateStructuralRepair(
  response: AIResponse,
  reference: string,
  aliases: ReadonlySet<string>,
  semanticProfile?: MaterializedSemanticProfile,
) {
  if (response.status !== 'OK' || response.raw_output === null)
    throw new Error('REPAIR_RESPONSE_NOT_COMPLETE');
  const wire = strictJson(response.raw_output);
  if (!validateRepairWire(wire)) throw new Error('INVALID_REPAIR_WIRE');
  const envelope = wire as {
    status: string;
    repaired_json: string | null;
    issues: string[];
  };
  if (
    envelope.status !== 'REPAIRED' ||
    typeof envelope.repaired_json !== 'string'
  )
    throw new Error('UNREPAIRABLE');
  const checked = semanticProfile
    ? await validateSemanticCandidate(
        envelope.repaired_json,
        'OK',
        aliases,
        semanticProfile,
      )
    : await validateEconomyCandidate(envelope.repaired_json, 'OK', aliases);
  if (!checked.valid) throw new Error('REPAIRED_ANALYSIS_INVALID');
  if (semanticTree(checked.value) !== semanticTree(strictJson(reference)))
    throw new Error('REPAIR_CHANGED_CONTENT');
  return { ...checked, envelope: { schema_version: '1.1', ...envelope } };
}
