import { sha256 } from '../../auth/crypto.js';
import { renderPrompt } from '../../registry/bundle.js';
import { validator_schema_hashes } from '../../registry/generated/validators.js';
import type { PromptSnapshot } from '../../registry/store.js';
import type {
  AIRequest,
  PipelineProfile,
} from '../../../../contracts/src/ai.js';
import { selectPipeline } from '../selector.js';
import type { TranslationPlan } from './translation.js';
import { historyPromptSide, type HistoryPlan } from './history.js';
interface OptionalCompilerInput {
  prompt: PromptSnapshot;
  profile: PipelineProfile;
  runtime: 'local' | 'cloud';
  mode: 'PRODUCTION' | 'QUALITY_TEST';
  purpose: string;
  region: string;
  max_output_tokens: number;
  request_id: string;
  deadline: string;
  now: Date;
}
async function compileOptional(
  input: OptionalCompilerInput,
  task: 'TRANSLATE' | 'HISTORICAL_COMPARE',
  planHash: string,
  bindings: Record<string, string>,
  scope: Record<string, unknown>,
) {
  const wire = task === 'TRANSLATE' ? 'translation-wire' : 'history-wire';
  const canonical = task === 'TRANSLATE' ? 'translation' : 'historical';
  const family =
    task === 'TRANSLATE' ? 'FULL_TRANSLATION_V1' : 'HISTORICAL_COMPARE_V1';
  if (
    input.prompt.prompt_id !== family ||
    !Number.isSafeInteger(input.prompt.version) ||
    input.prompt.version < 2 ||
    input.prompt.wire.id !== `urn:bartosz:schema:${wire}:1.0` ||
    input.prompt.canonical.id !== `urn:bartosz:schema:${canonical}:1.0` ||
    input.prompt.wire.hash !==
      (validator_schema_hashes as Record<string, string>)[
        input.prompt.wire.id
      ] ||
    input.prompt.canonical.hash !==
      (validator_schema_hashes as Record<string, string>)[
        input.prompt.canonical.id
      ] ||
    input.prompt.prompt_hash !== (await sha256(input.prompt.text)) ||
    input.prompt.wire.hash !==
      (await sha256(JSON.stringify(input.prompt.wire.schema))) ||
    input.prompt.canonical.hash !==
      (await sha256(JSON.stringify(input.prompt.canonical.schema)))
  )
    throw new Error('INCOMPATIBLE_OPTIONAL_PROMPT');
  if (
    !input.request_id ||
    !Number.isSafeInteger(input.max_output_tokens) ||
    input.max_output_tokens < 1 ||
    !Number.isFinite(input.now.getTime()) ||
    !Number.isFinite(Date.parse(input.deadline)) ||
    Date.parse(input.deadline) <= input.now.getTime() ||
    Date.parse(input.deadline) - input.now.getTime() > 300000
  )
    throw new Error('INVALID_OPTIONAL_REQUEST');
  const text = renderPrompt(input.prompt.text, {
    wire_schema_json: JSON.stringify(input.prompt.wire.schema),
    ...bindings,
  });
  const inputTokens = new TextEncoder().encode(text).length;
  const qualityScope = await sha256(
    JSON.stringify({
      task,
      prompt_hash: input.prompt.prompt_hash,
      wire_hash: input.prompt.wire.hash,
      canonical_hash: input.prompt.canonical.hash,
      provider: input.profile.provider_id,
      model: input.profile.model,
      scope,
      max_output_tokens: input.max_output_tokens,
      mapper_version: 'optional-source-mapper:1',
    }),
  );
  const selected = selectPipeline([input.profile], {
    profile_id: 'gemini_free',
    purpose: input.purpose,
    region: input.region,
    task_type: task,
    runtime: input.runtime,
    mode: input.mode,
    quality_scope: qualityScope,
    input_tokens: inputTokens,
    output_tokens: input.max_output_tokens,
    now: input.now,
    paid_services_enabled: false,
  });
  if (!selected.profile) throw new Error('OPTIONAL_PROFILE_' + selected.reason);
  const request: AIRequest = {
    request_id: input.request_id,
    runtime: input.runtime,
    profile: selected.profile,
    prompt: text,
    wire_schema: structuredClone(input.prompt.wire.schema),
    estimated_input_tokens: inputTokens,
    max_output_tokens: input.max_output_tokens,
    deadline: input.deadline,
    quality_scope: qualityScope,
    mode: input.mode,
    paid_services_enabled: false,
  };
  return {
    request,
    plan_hash: planHash,
    prompt_snapshot: structuredClone(input.prompt),
    token_estimate: {
      method: 'UTF8_BYTES_UPPER_ESTIMATE' as const,
      exact: false as const,
      input_tokens: inputTokens,
      output_tokens: input.max_output_tokens,
    },
    additional_model_requests: 1 as const,
    selection_effect: 'NONE' as const,
  };
}
export async function compileTranslation(
  input: OptionalCompilerInput & {
    plan: TranslationPlan;
    glossary: readonly { source: string; target: string }[];
  },
) {
  if (input.plan.hash !== (await sha256(JSON.stringify(input.plan.snapshot))))
    throw new Error('TRANSLATION_PLAN_MISMATCH');
  if (
    input.glossary.length > 100 ||
    input.glossary.some(
      (entry) =>
        !entry.source.trim() ||
        !entry.target.trim() ||
        entry.source.length > 256 ||
        entry.target.length > 256,
    ) ||
    new Set(input.glossary.map((entry) => entry.source)).size !==
      input.glossary.length
  )
    throw new Error('INVALID_LITERAL_GLOSSARY');
  return compileOptional(
    input,
    'TRANSLATE',
    input.plan.hash,
    {
      source_language: input.plan.snapshot.source_language,
      source_segments_with_aliases_json: JSON.stringify(
        input.plan.snapshot.segments.map((s) => ({
          segment_ref: s.alias,
          text: s.text,
        })),
      ),
      owner_glossary_json_or_empty: JSON.stringify(input.glossary),
    },
    {
      source_language: input.plan.snapshot.source_language,
      scope: input.plan.snapshot.scope,
      glossary_hash: await sha256(JSON.stringify(input.glossary)),
    },
  );
}
export async function compileHistory(
  input: OptionalCompilerInput & { plan: HistoryPlan },
) {
  if (input.plan.hash !== (await sha256(JSON.stringify(input.plan.snapshot))))
    throw new Error('HISTORY_PLAN_MISMATCH');
  return compileOptional(
    input,
    'HISTORICAL_COMPARE',
    input.plan.hash,
    {
      context_scope_json: JSON.stringify({
        cut: input.plan.snapshot.cut,
        scope_note_pl: input.plan.snapshot.scope_note_pl,
        current_observations: input.plan.snapshot.current.observations.length,
        prior_observations: input.plan.snapshot.prior.observations.length,
      }),
      current_observations_with_evidence_aliases_json: JSON.stringify(
        historyPromptSide(input.plan.snapshot.current),
      ),
      prior_observations_with_evidence_aliases_json: JSON.stringify(
        historyPromptSide(input.plan.snapshot.prior),
      ),
    },
    {
      max_current: 20,
      max_prior: 40,
      max_evidence: 120,
      context_selection: 'accepted-bounded:1',
    },
  );
}
