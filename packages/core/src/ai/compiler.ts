import { sha256 } from '../auth/crypto.js';
import { renderPrompt } from '../registry/bundle.js';
import type { PromptSnapshot } from '../registry/store.js';
import type { normalizeTranscript } from '../transcript/normalize.js';
import type { AIRequest, PipelineProfile } from '../../../contracts/src/ai.js';
type Manifest = Awaited<ReturnType<typeof normalizeTranscript>>['manifest'];
export async function analysisQualityScope(
  prompt: PromptSnapshot,
  profile: PipelineProfile,
  settings: {
    limits: Record<string, number>;
    max_output_tokens: number;
    source_language: string;
  },
) {
  return sha256(
    JSON.stringify({
      provider: profile.provider_id,
      model: profile.model,
      prompt_hash: prompt.prompt_hash,
      wire_hash: prompt.wire.hash,
      canonical_hash: prompt.canonical.hash,
      enrichment: prompt.enrichment_version,
      normalizer: 'source-normalizer:1',
      settings: {
        ...settings,
        limits: Object.fromEntries(
          Object.entries(settings.limits).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ),
      },
    }),
  );
}
export async function compileEconomy(input: {
  source_artifact_id: string;
  source_text: string;
  manifest: Manifest;
  manifest_hash: string;
  prompt: PromptSnapshot;
  profile: PipelineProfile;
  profile_revision: string;
  semantic_context: {
    title: string | null;
    author: string | null;
    published_at: string | null;
    source_language: string;
  };
  runtime: 'local' | 'cloud';
  request_id: string;
  deadline: string;
  mode: 'PRODUCTION' | 'QUALITY_TEST';
  max_output_tokens: number;
  limits: Record<string, number>;
}) {
  if (
    !Number.isSafeInteger(input.max_output_tokens) ||
    input.max_output_tokens < 1 ||
    input.max_output_tokens > input.profile.output_tokens ||
    Object.values(input.limits).some(
      (limit) => !Number.isSafeInteger(limit) || limit < 0,
    )
  )
    throw new Error('INVALID_ANALYSIS_LIMITS');
  if (
    input.prompt.prompt_id !== 'ECONOMY_ANALYSIS_V1' ||
    input.prompt.version !== 2 ||
    input.prompt.wire.id !== 'urn:bartosz:schema:economy-wire:1.0' ||
    input.prompt.canonical.id !==
      'urn:bartosz:schema:intelligence-canonical:1.2' ||
    (await sha256(input.prompt.text)) !== input.prompt.prompt_hash ||
    (await sha256(JSON.stringify(input.prompt.wire.schema))) !==
      input.prompt.wire.hash ||
    (await sha256(JSON.stringify(input.prompt.canonical.schema))) !==
      input.prompt.canonical.hash
  )
    throw new Error('INCOMPATIBLE_PROMPT_SNAPSHOT');
  const manifest = input.manifest;
  if (
    !manifest.complete ||
    !manifest.anchors.length ||
    manifest.normalizer_version !== 'source-normalizer:1' ||
    manifest.source_text_hash !== (await sha256(input.source_text)) ||
    manifest.source_revision !== manifest.source_text_hash ||
    (await sha256(JSON.stringify(manifest))) !== input.manifest_hash
  )
    throw new Error('INSUFFICIENT_SOURCE');
  const aliases = new Set<string>(),
    ids = new Set<string>();
  for (let index = 0; index < manifest.anchors.length; index++) {
    const anchor = manifest.anchors[index]!;
    if (
      anchor.alias !== `s${index + 1}` ||
      aliases.has(anchor.alias) ||
      ids.has(anchor.segment_id) ||
      anchor.source_start < 0 ||
      anchor.source_end > input.source_text.length ||
      anchor.source_end <= anchor.source_start ||
      !anchor.text.trim()
    )
      throw new Error('INVALID_SOURCE_MANIFEST');
    aliases.add(anchor.alias);
    ids.add(anchor.segment_id);
  }
  if (
    manifest.coverage.some(
      (row) =>
        !row.empty &&
        (!row.segment_ids.length || row.segment_ids.some((id) => !ids.has(id))),
    )
  )
    throw new Error('INCOMPLETE_SOURCE_COVERAGE');
  const text = renderPrompt(input.prompt.text, {
    wire_schema_json: JSON.stringify(input.prompt.wire.schema),
    semantic_context_json: JSON.stringify(input.semantic_context),
    limits_json: JSON.stringify(input.limits),
    source_segments_with_aliases_json: JSON.stringify(
      manifest.anchors.map((anchor) => ({
        segment_ref: anchor.alias,
        text: anchor.text,
      })),
    ),
    helper_segments_json_or_null: 'null',
  });
  // UTF-8 byte count is a conservative token upper bound, explicitly estimated.
  // A too-large source routes to a full-coverage ChunkPlan instead of truncation.
  const estimate = new TextEncoder().encode(text).length;
  if (estimate + input.max_output_tokens > input.profile.context_tokens)
    throw new Error('LONG_INPUT_REQUIRED');
  const settings = {
    limits: structuredClone(input.limits),
    max_output_tokens: input.max_output_tokens,
    source_language: input.semantic_context.source_language,
  };
  const scope = await analysisQualityScope(
    input.prompt,
    input.profile,
    settings,
  );
  const request: AIRequest = {
    request_id: input.request_id,
    runtime: input.runtime,
    profile: structuredClone(input.profile),
    prompt: text,
    wire_schema: structuredClone(input.prompt.wire.schema),
    estimated_input_tokens: estimate,
    max_output_tokens: input.max_output_tokens,
    deadline: input.deadline,
    quality_scope: scope,
    mode: input.mode,
    paid_services_enabled: false,
  };
  const runContext = {
    source_artifact_id: input.source_artifact_id,
    source_revision: manifest.source_revision,
    source_manifest_hash: input.manifest_hash,
    source_text_version: manifest.source_text_version,
    prompt_snapshot: structuredClone(input.prompt),
    profile_snapshot: structuredClone(input.profile),
    profile_revision: input.profile_revision,
    runtime: input.runtime,
    quality_scope: scope,
    token_estimate: { method: 'utf8-byte-upper-bound:1', input: estimate },
    generation_settings: { ...settings, thinking_level: 'low' },
    request_id: input.request_id,
  };
  return {
    request,
    run_context: runContext,
    context_hash: await sha256(JSON.stringify(runContext)),
  };
}
