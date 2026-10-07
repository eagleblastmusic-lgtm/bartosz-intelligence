import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { AIRequest, AIResponse } from '../../packages/contracts/src/ai.js';
import type { PromptSnapshot } from '../../packages/core/src/registry/store.js';
import { strictJson } from '../../packages/core/src/ai/repair/strict-json.js';
import { compileTranslation } from '../../packages/core/src/ai/tasks/compiler.js';
import {
  translationPlan,
  mapTranslation,
  type TranslationSource,
} from '../../packages/core/src/ai/tasks/translation.js';
import type { LabVariant } from '../../packages/core/src/registry/lab.js';
import type {
  TranslationTrial,
  VerifiedTranslationTrial,
} from './translation-evaluation.js';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export async function verifyTranslationFiles(
  trial: TranslationTrial,
  variant: LabVariant,
): Promise<VerifiedTranslationTrial> {
  const read = (path: string, expected?: string) => {
    if (statSync(path).size > 8 * 1024 * 1024)
      throw new Error('TRANSLATION_INPUT_TOO_LARGE');
    const text = readFileSync(path, 'utf8');
    if (Buffer.byteLength(text) > 8 * 1024 * 1024)
      throw new Error('TRANSLATION_INPUT_TOO_LARGE');
    if (expected !== undefined && hash(text) !== expected)
      throw new Error('TRANSLATION_FILE_HASH_MISMATCH');
    return strictJson(text);
  };
  const source = read(trial.files.source) as unknown as TranslationSource;
  if (source.manifest.source_text_hash !== trial.source_hash)
    throw new Error('TRANSLATION_SOURCE_MISMATCH');
  const plan = await translationPlan(source, 'FULL');
  const artifact = read(trial.files.request, trial.request_hash) as unknown as {
    request: AIRequest;
    prompt_snapshot: PromptSnapshot;
    purpose: string;
    region: string;
  };
  const { request, prompt_snapshot: prompt } = artifact;
  if (
    request.request_id !== trial.request_id ||
    request.mode !== 'QUALITY_TEST' ||
    request.paid_services_enabled !== false ||
    request.runtime !== 'local' ||
    request.profile.provider_id !== variant.provider ||
    request.profile.model !== variant.model ||
    request.profile.revision !== variant.model_revision ||
    request.max_output_tokens !== variant.max_output_tokens ||
    prompt.prompt_hash !== variant.prompt_hash ||
    prompt.wire.hash !== variant.wire_hash ||
    prompt.canonical.hash !== variant.canonical_hash ||
    variant.reasoning !== 'low' ||
    variant.seed !== null
  )
    throw new Error('TRANSLATION_REQUEST_CONTROL_MISMATCH');
  const compiled = await compileTranslation({
    prompt,
    profile: request.profile,
    runtime: request.runtime,
    mode: request.mode,
    purpose: artifact.purpose,
    region: artifact.region,
    max_output_tokens: request.max_output_tokens,
    request_id: request.request_id,
    deadline: request.deadline,
    now: new Date(trial.started_at),
    plan,
    glossary: [],
  });
  if (JSON.stringify(compiled.request) !== JSON.stringify(request))
    throw new Error('TRANSLATION_COMPILED_REQUEST_MISMATCH');
  const response = read(
    trial.files.response,
    trial.response_hash,
  ) as unknown as AIResponse;
  if (
    response.request_id !== trial.request_id ||
    response.actual_provider !== variant.provider ||
    (response.actual_model !== null &&
      response.actual_model !== variant.model) ||
    (response.status === 'OK' && response.actual_model === null)
  )
    throw new Error('TRANSLATION_RESPONSE_CONTROL_MISMATCH');
  const annotations = read(trial.files.annotations, trial.annotations_hash) as {
    source_hash: string;
    response_hash: string;
    ratings: unknown;
  };
  if (
    annotations.source_hash !== trial.source_hash ||
    annotations.response_hash !== trial.response_hash ||
    JSON.stringify(annotations.ratings) !== JSON.stringify(trial.ratings)
  )
    throw new Error('TRANSLATION_ANNOTATIONS_CHANGED');
  // This evaluator currently supports actual unassisted responses. Repair receipts
  // must be added and verified before repair-assisted output can qualify here.
  if (trial.ai_repairs !== 0)
    throw new Error('TRANSLATION_REPAIR_RECEIPT_REQUIRED');
  let rawValid = false,
    duplicateSegments = false;
  if (response.raw_output !== null)
    try {
      const parsed = strictJson(response.raw_output) as {
        translated_segments?: { segment_ref: string }[];
      };
      rawValid = true;
      if (Array.isArray(parsed.translated_segments))
        duplicateSegments =
          new Set(parsed.translated_segments.map((row) => row.segment_ref))
            .size !== parsed.translated_segments.length;
    } catch {
      /* Preserve invalid actual output in the denominator. */
    }
  let mapped: Awaited<ReturnType<typeof mapTranslation>> | null = null;
  try {
    mapped = await mapTranslation(plan, response);
  } catch {
    /* Refused/invalid/partial output does not disappear. */
  }
  return {
    request_id: trial.request_id,
    raw_valid: rawValid,
    mapped_valid: mapped !== null,
    complete: mapped?.coverage.complete ?? false,
    deterministic_repairs: mapped?.repair_report.applied ?? [],
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    wire_bytes:
      response.raw_output === null ? 0 : Buffer.byteLength(response.raw_output),
    canonical_bytes:
      mapped === null
        ? null
        : Buffer.byteLength(JSON.stringify(mapped.canonical)),
    missing_segments: mapped?.coverage.missing_segment_ids.length ?? null,
    duplicate_segments: duplicateSegments,
  };
}
