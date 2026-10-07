export interface LabVariant {
  id: 'A' | 'B';
  provider: string;
  model: string;
  model_revision: number;
  prompt_hash: string;
  wire_hash: string;
  canonical_hash: string;
  reasoning: string;
  max_output_tokens: number;
  seed: number | null;
}
export interface LabControls {
  version: 'lab-controls:1';
  mode: 'PROMPT_AB' | 'MODEL_AB';
  source_hashes: string[];
  repeats: 1 | 3;
  variants: [LabVariant, LabVariant];
  confounders: string[];
}
/** Controls are checked before any job is submitted. No inferred quality scores. */
export function validateLabControls(input: LabControls) {
  const hash = (value: string) => /^[a-f0-9]{64}$/.test(value);
  if (
    !input ||
    input.version !== 'lab-controls:1' ||
    !['PROMPT_AB', 'MODEL_AB'].includes(input.mode) ||
    ![1, 3].includes(input.repeats) ||
    !Array.isArray(input.source_hashes) ||
    input.source_hashes.length < 1 ||
    input.source_hashes.length > 50 ||
    new Set(input.source_hashes).size !== input.source_hashes.length ||
    input.source_hashes.some((value) => !hash(value)) ||
    !Array.isArray(input.variants) ||
    input.variants.length !== 2 ||
    !Array.isArray(input.confounders) ||
    new Set(input.confounders).size !== input.confounders.length
  )
    throw new Error('INVALID_LAB_CONTROLS');
  const [a, b] = input.variants;
  for (const [index, variant] of input.variants.entries()) {
    if (
      !variant ||
      variant.id !== (index === 0 ? 'A' : 'B') ||
      variant.provider !== 'gemini' ||
      !variant.model ||
      !Number.isSafeInteger(variant.model_revision) ||
      variant.model_revision < 1 ||
      !hash(variant.prompt_hash) ||
      !hash(variant.wire_hash) ||
      !hash(variant.canonical_hash) ||
      !variant.reasoning ||
      !Number.isSafeInteger(variant.max_output_tokens) ||
      variant.max_output_tokens < 1 ||
      (variant.seed !== null && !Number.isSafeInteger(variant.seed))
    )
      throw new Error('INVALID_LAB_VARIANT');
  }
  if (
    a.provider !== b.provider ||
    a.wire_hash !== b.wire_hash ||
    a.canonical_hash !== b.canonical_hash ||
    a.reasoning !== b.reasoning ||
    a.max_output_tokens !== b.max_output_tokens ||
    a.seed !== b.seed
  )
    throw new Error('LAB_CONTROL_MISMATCH');
  if (
    input.mode === 'PROMPT_AB'
      ? a.model !== b.model ||
        a.model_revision !== b.model_revision ||
        a.prompt_hash === b.prompt_hash
      : a.prompt_hash !== b.prompt_hash || a.model === b.model
  )
    throw new Error('LAB_COMPARISON_AXIS_MISMATCH');
  // The current Gemini adapter exposes no seed. Recording one would imply false control.
  if (a.seed !== null) throw new Error('LAB_SEED_UNSUPPORTED');
  if (
    !input.confounders.includes('SEED_UNAVAILABLE') ||
    !input.confounders.includes('PROVIDER_NONDETERMINISM') ||
    (input.mode === 'MODEL_AB' &&
      !input.confounders.includes('MODEL_REASONING_IMPLEMENTATION'))
  )
    throw new Error('LAB_CONFOUNDER_NOT_RECORDED');
  return structuredClone(input);
}
