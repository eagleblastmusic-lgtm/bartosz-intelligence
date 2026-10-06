import { it, expect } from 'vitest';
import {
  compileEconomy,
  compileSemanticAnalysis,
  economyChunkContextHash,
} from '../../packages/core/src/ai/compiler.js';
import { createChunkPlan } from '../../packages/core/src/ai/long-input/plan.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import {
  executeAnalysis,
  executeRepair,
} from '../../apps/executor/src/analysis-runner.js';
import {
  compileStructuralRepair,
  validateStructuralRepair,
} from '../../packages/core/src/ai/repair/structural.js';
import type { PromptSnapshot } from '../../packages/core/src/registry/store.js';
import type {
  PipelineProfile,
  AIResponse,
} from '../../packages/contracts/src/ai.js';
import bundle from '../../config/registry/master-bundle.json';
import {
  compileSemanticProfile,
  semanticModules,
} from '../../packages/core/src/ai/semantic-profile.js';
import { semanticPrompt } from '../../packages/core/src/registry/semantic-profiles.js';
async function fixture() {
  const text = 'I did not adopt Tool X.',
    source = await normalizeTranscript(
      await sha256(text),
      [
        {
          upstream_index: 0,
          text,
          start_ms: 0,
          end_ms: 2000,
          speaker_label: null,
        },
      ],
      'CUE',
    );
  const template = bundle.prompts.find(
      (row) => row.id === 'ECONOMY_ANALYSIS_V1',
    )!,
    wire = bundle.schemas.find(
      (row) => row.id === 'urn:bartosz:schema:economy-wire:1.0',
    )!,
    canonical = bundle.schemas.find(
      (row) => row.id === 'urn:bartosz:schema:intelligence-canonical:1.2',
    )!;
  const prompt: PromptSnapshot = {
    prompt_id: template.id,
    version: 2,
    prompt_hash: template.hash,
    text: template.text,
    wire,
    canonical,
    enrichment_version: '1.0',
    generation: 1,
  };
  const profile: PipelineProfile = {
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
  };
  return {
    source_artifact_id: 'private-artifact-id',
    source_text: text,
    manifest: source.manifest,
    manifest_hash: source.manifest_hash,
    prompt,
    profile,
    profile_revision: '1',
    semantic_context: {
      title: 'Fixture',
      author: null,
      published_at: null,
      source_language: 'en',
    },
    runtime: 'local' as const,
    request_id: 'request',
    deadline: '2026-10-06T01:00:00Z',
    mode: 'QUALITY_TEST' as const,
    max_output_tokens: 512,
    limits: { claims: 40 },
  };
}
it.each(['FULL', 'CUSTOM'] as const)(
  'compiles %s from its pinned scope with an explicit extraction pass and no hidden provider switch',
  async (mode) => {
    const input = await fixture();
    const semantic = await compileSemanticProfile(
      {
        mode,
        modules: Object.fromEntries(
          semanticModules.map((key) => [
            key,
            mode === 'FULL' || key === 'claims',
          ]),
        ),
        translation: 'NONE',
        history: false,
        second_pass: null,
        validation_pass: null,
      },
      bundle,
    );
    const prompt = semanticPrompt({
      profile_id: 'semantic',
      revision: 1,
      name: 'Semantic',
      compiled: semantic,
    });
    const economy = await compileEconomy(input);
    const compiled = await compileSemanticAnalysis({
      ...input,
      prompt,
      semantic_profile: semantic,
    });
    expect(compiled.request.runtime).toBe('local');
    expect(compiled.request.profile.profile_id).toBe('gemini_free');
    expect(compiled.request.paid_services_enabled).toBe(false);
    expect(compiled.request.wire_schema).toEqual(semantic.wire.schema);
    expect(compiled.run_context.prompt_snapshot).toEqual(prompt);
    expect(compiled.request.quality_scope).not.toBe(
      economy.request.quality_scope,
    );
    expect(compiled.request.prompt).toContain(input.source_text);
    expect(compiled.request.prompt).not.toMatch(/\{\{[a-z_]+\}\}/);
    if (mode === 'CUSTOM') {
      expect(compiled.request.prompt).toContain('PASS_MODE: EXTRACT');
      expect(compiled.request.prompt).toContain('EXISTING_CANDIDATE: null');
      expect(
        (compiled.request.wire_schema.properties as Record<string, unknown>)
          .summary_pl,
      ).toBeUndefined();
    }
    await expect(
      compileSemanticAnalysis({
        ...input,
        prompt: { ...prompt, wire: input.prompt.wire },
        semantic_profile: semantic,
      }),
    ).rejects.toThrow('INCOMPATIBLE_PROMPT_SNAPSHOT');
  },
);
it.each(['SECOND_PASS', 'VALIDATE'] as const)(
  'compiles explicit Custom %s with same source aliases, purpose and candidate pins',
  async (mode) => {
    const input = await fixture(),
      purpose = 'Sprawdź zachowanie negacji.';
    const semantic = await compileSemanticProfile(
      {
        mode: 'CUSTOM',
        modules: Object.fromEntries(
          semanticModules.map((key) => [key, key === 'claims']),
        ),
        translation: 'NONE',
        history: false,
        second_pass: { purpose },
        validation_pass: { purpose },
      },
      bundle,
    );
    const prompt = semanticPrompt({
      profile_id: 'custom-pass',
      revision: 1,
      name: 'Custom',
      compiled: semantic,
    });
    const candidate = {
      entity_mentions: [],
      source_issues: [],
      claims: [
        {
          text_pl: 'Autor nie wdrożył narzędzia.',
          segment_refs: ['s1'],
          entity_refs: [],
          subject_ref: null,
          attribution: 'SOURCE_SPEAKER',
          qualifiers: [],
        },
      ],
    };
    const pass = {
      mode,
      purpose,
      candidate_run_id: 'immutable-prior-run',
      candidate_hash: await sha256(JSON.stringify(candidate)),
      candidate_wire: candidate,
    };
    const base = { ...input, prompt, semantic_profile: semantic };
    const extraction = await compileSemanticAnalysis(base),
      compiled = await compileSemanticAnalysis({
        ...base,
        additional_pass: pass,
      });
    expect(compiled.request.prompt).toContain('PASS_MODE: ' + mode);
    expect(compiled.request.prompt).toContain(
      'SOURCE: [{"segment_ref":"s1","text":"I did not adopt Tool X."}]',
    );
    expect(compiled.request.prompt).toContain(
      'EXISTING_CANDIDATE: ' + JSON.stringify(candidate),
    );
    expect(compiled.request.prompt).toContain(purpose);
    expect(compiled.run_context.additional_pass).toEqual(pass);
    expect(compiled.request.quality_scope).not.toBe(
      extraction.request.quality_scope,
    );
    expect(compiled.request.wire_schema).toEqual(
      extraction.request.wire_schema,
    );
    expect(extraction.request.prompt).toContain('EXISTING_CANDIDATE: null');
    await expect(
      compileSemanticAnalysis({
        ...base,
        additional_pass: { ...pass, purpose: 'Inny cel' },
      }),
    ).rejects.toThrow('ADDITIONAL_PASS_PURPOSE_MISMATCH');
    await expect(
      compileSemanticAnalysis({
        ...base,
        additional_pass: { ...pass, candidate_hash: '0'.repeat(64) },
      }),
    ).rejects.toThrow('ADDITIONAL_PASS_CANDIDATE_MISMATCH');
    const foreign = structuredClone(candidate);
    foreign.claims[0]!.segment_refs = ['foreign'];
    await expect(
      compileSemanticAnalysis({
        ...base,
        additional_pass: {
          ...pass,
          candidate_wire: foreign,
          candidate_hash: await sha256(JSON.stringify(foreign)),
        },
      }),
    ).rejects.toThrow('INVALID_ADDITIONAL_PASS_CANDIDATE');
  },
);
it('chunk compiler pins full original source but sends only assigned local aliases and a distinct quality scope', async () => {
  const input = await fixture();
  const cues = Array.from({ length: 200 }, (_, index) => ({
    upstream_index: index,
    text: `Cue ${index}: ` + 'ordinary source statement '.repeat(6),
    start_ms: index * 1000,
    end_ms: index * 1000 + 1500,
    speaker_label: null,
  }));
  const source = await normalizeTranscript(
    await sha256(cues.map((c) => c.text).join('\n')),
    cues,
    'CUE',
  );
  Object.assign(input, {
    source_text: source.source_text,
    manifest: source.manifest,
    manifest_hash: source.manifest_hash,
  });
  input.profile.context_tokens = 12000;
  const built = await createChunkPlan({
    ...source,
    context_hash: await economyChunkContextHash(input),
    context_tokens: 12000,
    output_tokens: input.max_output_tokens,
    prompt_overhead_tokens: 7000,
  });
  const part = built.plan.chunks[1]!;
  const compiled = await compileEconomy({
    ...input,
    chunk: { ...built, chunk_index: 1 },
  });
  expect(compiled.run_context.chunk?.assigned_aliases).toEqual(part.aliases);
  expect(compiled.run_context.source_revision).toBe(
    source.manifest.source_revision,
  );
  expect(compiled.request.prompt).toContain(
    source.manifest.anchors[part.primary_start]!.text,
  );
  expect(compiled.request.prompt).not.toContain(
    source.manifest.anchors[0]!.text,
  );
  expect(compiled.request.prompt).toContain('"segment_ref":"s1"');
  expect(compiled.run_context.generation_settings.analysis_mode).toBe('CHUNK');
  const changed = {
    ...input,
    limits: { claims: 1 },
    chunk: { ...built, chunk_index: 1 },
  };
  await expect(compileEconomy(changed)).rejects.toThrow(
    'CHUNK_CONTEXT_MISMATCH',
  );
});
it('one admitted structural repair preserves content and cannot repair its envelope or semantic errors', async () => {
  const main = (await compileEconomy(await fixture())).request;
  // Synthetic budget and measured error class are fixture inputs, not a live approval.
  main.estimated_input_tokens = 50000;
  const template = bundle.prompts.find((row) => row.id === 'JSON_REPAIR_V1')!;
  const prompt: PromptSnapshot = {
    prompt_id: template.id,
    version: 2,
    prompt_hash: template.hash,
    text: template.text,
    wire: bundle.schemas.find(
      (row) => row.id === 'urn:bartosz:schema:repair-wire:1.0',
    )!,
    canonical: bundle.schemas.find(
      (row) => row.id === 'urn:bartosz:schema:repair-envelope:1.1',
    )!,
    enrichment_version: '1.0',
    generation: 1,
  };
  const wire = {
    summary_pl: [
      { text_pl: 'Autor nie wdrożył narzędzia.', segment_refs: ['s1'] },
    ],
    key_points: [],
    entity_mentions: [],
    tools: [],
    claims: [],
    stance: [],
    predictions: [],
    source_issues: [],
  };
  const raw = JSON.stringify(wire).slice(0, -1) + ',}';
  const input = {
    raw,
    completion: 'OK' as const,
    prompt,
    main,
    request_id: 'repair-test',
    deadline: main.deadline,
    aliases: new Set(['s1']),
    measurement: {
      error_class: 'TRAILING_COMMA' as const,
      evidence_hash: 'a'.repeat(64),
    },
  };
  let claimed = false,
    calls = 0,
    reserves = 0;
  const response: AIResponse = {
    request_id: 'repair-test',
    status: 'OK',
    raw_output: JSON.stringify({
      status: 'REPAIRED',
      repaired_json: JSON.stringify(wire),
      issues: ['trailing comma'],
    }),
    actual_provider: 'gemini',
    actual_model: 'gemini-3.8-flash',
    finish_reason: 'completed',
    usage: { input_tokens: 12, output_tokens: 12, total_tokens: 24 },
    retry_after: null,
  };
  const lifecycle = {
    reserve: async () => {
      reserves++;
      return { reservation_id: 'repair-permit', request_id: 'repair-test' };
    },
    heartbeat: async () => {},
    retainCandidate: async () => {},
    reconcile: async () => {},
    diagnostic: async () => {},
    claimRepair: async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    },
  };
  const provider = {
    provider_id: 'gemini',
    run: async () => {
      calls++;
      return response;
    },
  };
  const result = await executeRepair(input, provider, lifecycle);
  expect(result.validated?.value).toEqual(wire);
  await expect(executeRepair(input, provider, lifecycle)).rejects.toThrow(
    'REPAIR_ALREADY_CONSUMED_OR_STALE',
  );
  expect(calls).toBe(1);
  await expect(
    executeRepair({ ...input, measurement: null }, provider, lifecycle),
  ).rejects.toThrow('REPAIR_NOT_ADMITTED');
  await expect(
    executeRepair(
      { ...input, main: { ...main, estimated_input_tokens: 1 } },
      provider,
      lifecycle,
    ),
  ).rejects.toThrow('REPAIR_COST_NOT_ADMITTED');
  expect(reserves).toBe(2);
  const compiled = await compileStructuralRepair(input);
  for (const mode of ['FULL', 'CUSTOM'] as const) {
    const semantic = await compileSemanticProfile(
      {
        mode,
        modules: Object.fromEntries(
          semanticModules.map((key) => [
            key,
            mode === 'FULL' || key === 'claims',
          ]),
        ),
        translation: 'NONE',
        history: false,
        second_pass: null,
        validation_pass: null,
      },
      bundle,
    );
    const scopedWire = Object.fromEntries(
      Object.keys(
        semantic.wire.schema.properties as Record<string, unknown>,
      ).map((key) => [key, key === 'summary_pl' ? wire.summary_pl : []]),
    );
    const scopedInput = {
      ...input,
      semantic_profile: semantic,
      raw: JSON.stringify(scopedWire).slice(0, -1) + ',}',
      main: { ...main, wire_schema: semantic.wire.schema },
    };
    const repair = await compileStructuralRepair(scopedInput);
    expect(repair.request.prompt).toContain(
      JSON.stringify(semantic.wire.schema),
    );
    expect(
      (
        await validateStructuralRepair(
          {
            ...response,
            raw_output: JSON.stringify({
              status: 'REPAIRED',
              repaired_json: JSON.stringify(scopedWire),
              issues: [],
            }),
          },
          repair.reference,
          input.aliases,
          semantic,
        )
      ).value,
    ).toEqual(scopedWire);
    await expect(
      compileStructuralRepair({ ...scopedInput, main }),
    ).rejects.toThrow('REPAIR_SCHEMA_MISMATCH');
    await expect(
      validateStructuralRepair(
        {
          ...response,
          raw_output: JSON.stringify({
            status: 'REPAIRED',
            repaired_json: JSON.stringify({ ...scopedWire, hidden: [] }),
            issues: [],
          }),
        },
        repair.reference,
        input.aliases,
        semantic,
      ),
    ).rejects.toThrow('REPAIRED_ANALYSIS_INVALID');
  }
  expect(compiled.request.prompt).not.toContain('I did not adopt Tool X.');
  expect(compiled.request.wire_schema.$id).toBe(
    'urn:bartosz:schema:repair-wire:1.0',
  );
  for (const repaired of [
    '{}',
    JSON.stringify({
      ...wire,
      summary_pl: [
        { text_pl: 'Autor wdrożył narzędzie.', segment_refs: ['s1'] },
      ],
    }),
    JSON.stringify({
      ...wire,
      summary_pl: [
        { text_pl: 'Autor nie wdrożył narzędzia.', segment_refs: ['s2'] },
      ],
    }),
  ])
    await expect(
      validateStructuralRepair(
        {
          ...response,
          raw_output: JSON.stringify({
            status: 'REPAIRED',
            repaired_json: repaired,
            issues: [],
          }),
        },
        compiled.reference,
        input.aliases,
      ),
    ).rejects.toThrow();
  await expect(
    validateStructuralRepair(
      { ...response, raw_output: '{}' },
      compiled.reference,
      input.aliases,
    ),
  ).rejects.toThrow('INVALID_REPAIR_WIRE');
  for (const invalid of [
    '{"a":1,"a":2,}',
    raw.slice(0, -2),
    JSON.stringify({ ...wire, source_issues: ['unsupported'] }).slice(0, -1) +
      ',}',
  ])
    await expect(
      compileStructuralRepair({ ...input, raw: invalid }),
    ).rejects.toThrow();
});
it('pins complete source and exact registry context without technical IDs in semantic input', async () => {
  const input = await fixture(),
    compiled = await compileEconomy(input);
  expect(compiled.request.prompt).toContain('I did not adopt Tool X.');
  expect(compiled.request.prompt).not.toContain(input.source_artifact_id);
  expect(compiled.request.prompt).toContain('"segment_ref":"s1"');
  input.prompt.text = 'changed';
  input.profile.model = 'changed';
  expect(compiled.run_context.prompt_snapshot.text).not.toBe('changed');
  expect(compiled.request.profile.model).toBe('gemini-3.8-flash');
  const changedLimits = await fixture();
  changedLimits.limits.claims = 1;
  expect((await compileEconomy(changedLimits)).request.quality_scope).not.toBe(
    compiled.request.quality_scope,
  );
  changedLimits.max_output_tokens = NaN;
  await expect(compileEconomy(changedLimits)).rejects.toThrow(
    'INVALID_ANALYSIS_LIMITS',
  );
  const huge = await fixture();
  huge.profile.context_tokens = 10;
  await expect(compileEconomy(huge)).rejects.toThrow('LONG_INPUT_REQUIRED');
  const incomplete = await fixture();
  incomplete.manifest.complete = false;
  await expect(compileEconomy(incomplete)).rejects.toThrow(
    'INSUFFICIENT_SOURCE',
  );
  const differentSchema = await fixture();
  differentSchema.prompt.wire = structuredClone(differentSchema.prompt.wire);
  differentSchema.prompt.wire.schema.description =
    'Changed under the same schema identity';
  differentSchema.prompt.wire.hash = await sha256(
    JSON.stringify(differentSchema.prompt.wire.schema),
  );
  await expect(compileEconomy(differentSchema)).rejects.toThrow(
    'INCOMPATIBLE_PROMPT_SNAPSHOT',
  );
});
it('one ordinary call retains candidate before settling usage; stale response is diagnostic only', async () => {
  const compiled = await compileEconomy(await fixture()),
    events: string[] = [];
  const response: AIResponse = {
    request_id: 'request',
    status: 'OK',
    raw_output: '{}',
    actual_provider: 'gemini',
    actual_model: 'gemini-3.8-flash',
    finish_reason: 'completed',
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    retry_after: null,
  };
  const result = await executeAnalysis(
    compiled.request,
    {
      provider_id: 'gemini',
      run: async () => {
        events.push('request');
        return response;
      },
    },
    {
      reserve: async () => {
        events.push('reserve');
        return { reservation_id: 'reserved', request_id: 'request' };
      },
      heartbeat: async () => {
        events.push('heartbeat');
        throw new Error('expired');
      },
      retainCandidate: async () => {
        events.push('candidate');
      },
      reconcile: async () => {
        events.push('usage');
      },
      diagnostic: async () => {
        events.push('diagnostic');
      },
    },
  );
  expect(events).toEqual([
    'reserve',
    'request',
    'heartbeat',
    'candidate',
    'usage',
    'diagnostic',
  ]);
  expect(result.eligible_for_validation).toBe(false);
});
