import { it, expect } from 'vitest';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import {
  translationPlan,
  mapTranslation,
} from '../../packages/core/src/ai/tasks/translation.js';
import {
  historyPlan,
  mapHistory,
  historyPromptSide,
  type HistoryRecord,
} from '../../packages/core/src/ai/tasks/history.js';
import { enrichEconomy } from '../../packages/core/src/ai/enrichment/canonical.js';
import {
  compileHistory,
  compileTranslation,
} from '../../packages/core/src/ai/tasks/compiler.js';
import type { PromptSnapshot } from '../../packages/core/src/registry/store.js';
import type { PipelineProfile } from '../../packages/contracts/src/ai.js';
import bundle from '../../config/registry/master-bundle.json';
import {
  missingTranslationPlan,
  composeTranslations,
} from '../../packages/core/src/ai/tasks/translation-recovery.js';
async function fixture() {
  const text = 'I did not use Tool X at 12%.\nIf unclear, do not guess.';
  return {
    owner_id: 'owner',
    source_artifact_id: 'original',
    source_language: 'en',
    video_url: null,
    ...(await normalizeTranscript(
      await sha256(text),
      [
        {
          upstream_index: 0,
          text: text.split('\n')[0]!,
          start_ms: 1000,
          end_ms: 2000,
          speaker_label: null,
        },
        {
          upstream_index: 1,
          text: text.split('\n')[1]!,
          start_ms: null,
          end_ms: null,
          speaker_label: null,
        },
      ],
      'CUE',
    )),
  };
}
it('retries only missing original segments and composes complete helper without an extra model pass', async () => {
  const source = await fixture(),
    parent = await translationPlan(source, 'FULL');
  const partial = await mapTranslation(parent, {
    status: 'OK',
    raw_output: JSON.stringify({
      status: 'OK',
      translated_segments: [
        {
          segment_ref: 's1',
          text_pl: 'Nie użyłem narzędzia przy 12%.',
          issues: [],
        },
      ],
      limitations_pl: ['Drugi segment nie został zwrócony.'],
    }),
  });
  const retry = await missingTranslationPlan(parent, partial);
  expect(retry.snapshot.segments.map((s) => s.source_segment_id)).toEqual([
    parent.snapshot.segments[1]!.source_segment_id,
  ]);
  expect(retry.snapshot.segments[0]).toMatchObject({
    alias: 's1',
    text: 'If unclear, do not guess.',
    start_ms: null,
    end_ms: null,
  });
  const recovered = await mapTranslation(retry, {
    status: 'OK',
    raw_output: JSON.stringify({
      status: 'OK',
      translated_segments: [
        { segment_ref: 's1', text_pl: 'Gdy niejasne, nie zgaduj.', issues: [] },
      ],
      limitations_pl: ['Niejasne brzmienie źródła.'],
    }),
  });
  const parts = [
    { plan: parent, mapped: partial },
    { plan: retry, mapped: recovered },
  ];
  const result = await composeTranslations(parent, parts);
  expect(result.coverage).toMatchObject({
    expected: 2,
    translated: 2,
    complete: true,
    missing_segment_ids: [],
  });
  expect(result.canonical.scope).toBe('FULL');
  expect(result.helper_text).toBe(
    'Nie użyłem narzędzia przy 12%.\nGdy niejasne, nie zgaduj.',
  );
  expect(result.mappings.map((m) => [m.start_ms, m.end_ms])).toEqual([
    [1000, 2000],
    [null, null],
  ]);
  expect(result.repair_report.result).toBe('DETERMINISTIC_TRANSLATION_MERGE');
  expect(
    (await composeTranslations(parent, [...parts].reverse())).canonical_hash,
  ).toBe(result.canonical_hash);
  expect(
    (await composeTranslations(parent, [...parts].reverse())).repair_report,
  ).toEqual(result.repair_report);
  const changedPart = structuredClone(parts[1]!);
  changedPart.plan.snapshot.segments[0]!.start_ms = 123;
  changedPart.plan.hash = await sha256(
    JSON.stringify(changedPart.plan.snapshot),
  );
  changedPart.mapped.plan_hash = changedPart.plan.hash;
  await expect(
    composeTranslations(parent, [parts[0]!, changedPart]),
  ).rejects.toThrow('TRANSLATION_RECOVERY_PART_MISMATCH');
  await expect(
    composeTranslations(parent, [parts[0]!, parts[0]!]),
  ).rejects.toThrow('DUPLICATE_TRANSLATION_RECOVERY_SEGMENT');
  await expect(
    missingTranslationPlan(
      parent,
      await mapTranslation(parent, {
        status: 'OK',
        raw_output: JSON.stringify({
          status: 'OK',
          translated_segments: [
            { segment_ref: 's1', text_pl: 'Jeden.', issues: [] },
            { segment_ref: 's2', text_pl: 'Dwa.', issues: [] },
          ],
          limitations_pl: [],
        }),
      }),
    ),
  ).rejects.toThrow('TRANSLATION_RECOVERY_NOT_NEEDED');
});
const response = (segments: unknown[], status = 'OK') => ({
  status: 'OK' as const,
  raw_output: JSON.stringify({
    status,
    translated_segments: segments,
    limitations_pl: [],
  }),
});
it('maps exact source segments, numbers/negation and original/unknown time without replacing source', async () => {
  const source = await fixture(),
    before = structuredClone(source);
  const plan = await translationPlan(source, 'FULL');
  const result = await mapTranslation(
    plan,
    response([
      {
        segment_ref: 's1',
        text_pl: 'Nie używałem Tool X przy 12%.',
        issues: [],
      },
      {
        segment_ref: 's2',
        text_pl: 'Jeśli niejasne, nie zgaduj.',
        issues: ['ASR_UNCERTAIN'],
      },
    ]),
  );
  expect(result.state).toBe('COMPLETE');
  expect(result.coverage.complete).toBe(true);
  expect(result.mappings.map((m) => [m.start_ms, m.end_ms])).toEqual([
    [1000, 2000],
    [null, null],
  ]);
  expect(
    result.canonical.translated_segments.map((s) => s.source_segment_id),
  ).toEqual(source.manifest.anchors.map((s) => s.segment_id));
  expect(result.helper_text).toContain('Nie używałem Tool X przy 12%.');
  expect(result.semantic_verification).toBe('NOT_ASSERTED');
  expect(source).toEqual(before);
});
it('selected scope is code-owned, reordered inputs use source order and missing segments stay partial', async () => {
  const source = await fixture(),
    ids = source.manifest.anchors.map((s) => s.segment_id);
  const plan = await translationPlan(source, 'SELECTED_SEGMENTS', [ids[1]!]);
  expect(plan.snapshot.segments[0]!.text).toBe('If unclear, do not guess.');
  expect(plan.snapshot.segments[0]!.alias).toBe('s1');
  const complete = await mapTranslation(
    plan,
    response([
      { segment_ref: 's1', text_pl: 'Jeśli niejasne, nie zgaduj.', issues: [] },
    ]),
  );
  expect(complete.coverage.complete).toBe(true);
  const partial = await mapTranslation(
    await translationPlan(source, 'FULL'),
    response([{ segment_ref: 's1', text_pl: 'Nie używałem.', issues: [] }]),
  );
  expect(partial.state).toBe('PARTIAL');
  expect(partial.coverage.missing_segment_ids).toEqual([ids[1]]);
  expect(
    (
      await translationPlan(source, 'CHUNK', [...ids].reverse())
    ).snapshot.segments.map((s) => s.source_segment_id),
  ).toEqual(ids);
  await expect(translationPlan(source, 'FULL', ids)).rejects.toThrow(
    'INVALID_TRANSLATION_SCOPE',
  );
  await expect(
    translationPlan(source, 'SELECTED_SEGMENTS', ['foreign']),
  ).rejects.toThrow('FOREIGN_TRANSLATION_SEGMENT');
  await expect(
    translationPlan(source, 'CHUNK', [ids[0]!, ids[0]!]),
  ).rejects.toThrow('DUPLICATE_TRANSLATION_SEGMENT');
});
it('rejects foreign/duplicate/reordered refs, false success, truncation and technical metadata injection', async () => {
  const plan = await translationPlan(await fixture(), 'FULL');
  const row = { segment_ref: 's1', text_pl: 'Nie używałem.', issues: [] };
  for (const output of [
    response([{ ...row, segment_ref: 'foreign' }]),
    response([row, row]),
    response([{ ...row, segment_ref: 's2' }, row]),
    response([row], 'REFUSED'),
    response([{ ...row, start_ms: 7 }]),
    { status: 'INCOMPLETE' as const, raw_output: '{}' },
  ])
    await expect(mapTranslation(plan, output)).rejects.toThrow();
  const changed = structuredClone(plan);
  changed.snapshot.source_hash = 'f'.repeat(64);
  await expect(mapTranslation(changed, response([]))).rejects.toThrow(
    'TRANSLATION_PLAN_MISMATCH',
  );
  const refused = await mapTranslation(plan, response([], 'REFUSED'));
  expect(refused.state).toBe('PARTIAL');
  expect(refused.canonical.status).toBe('REFUSED');
});
async function historyFixture() {
  const source = await fixture();
  const records: HistoryRecord[] = [];
  for (const item of ['current', 'prior', 'unused']) {
    const run = 'run-' + item;
    const enriched = await enrichEconomy({
      raw: JSON.stringify({
        summary_pl: [{ text_pl: 'Brak wdrożenia.', segment_refs: ['s1'] }],
        key_points: [],
        entity_mentions: [],
        tools: [],
        claims: [
          {
            text_pl: 'Nie wdrożono narzędzia.',
            segment_refs: ['s1'],
            subject_ref: null,
            entity_refs: [],
            attribution: 'SOURCE_SPEAKER',
            qualifiers: ['warunek'],
          },
        ],
        stance: [],
        predictions: [],
        source_issues: [],
      }),
      completion: 'OK',
      run_id: run,
      item_id: item,
      profile_id: 'economy',
      profile_revision: '1',
      source: { ...source, source_artifact_id: 'original-' + item },
      approved_aliases: [],
    });
    const row = enriched.canonical.claims[0]!;
    records.push({
      owner_id: 'owner',
      item_id: item,
      run_id: run,
      accepted_at: '2026-10-05T00:00:00Z',
      published_at: item === 'prior' ? null : '2026-10-04T00:00:00Z',
      row,
      row_hash: await sha256(JSON.stringify(row)),
      evidence: enriched.canonical.evidence.filter((e) =>
        row.evidence_ids.includes(e.evidence_id),
      ),
    });
  }
  return {
    owner_id: 'owner',
    current_item_id: 'current',
    current_run_id: 'run-current',
    cut: '2026-10-06T00:00:00Z',
    scope_note_pl:
      'Ograniczony kontekst przyjętych wypowiedzi, nie cała historia.',
    current: [records[0]!],
    prior: records.slice(1),
  };
}
const relation = {
  relation_type: 'NOT_COMPARABLE',
  current_observation_refs: ['co1'],
  prior_observation_refs: ['po1'],
  current_evidence_refs: ['ce1'],
  prior_evidence_refs: ['pe1'],
  explanation_pl: 'Różny zakres; brak wzmianki nie oznacza zmiany stanowiska.',
  qualifiers: ['warunek'],
};
const historyResponse = (relations: unknown[], status = 'OK') => ({
  status: 'OK' as const,
  raw_output: JSON.stringify({
    status,
    relations,
    limitations_pl: ['Kontekst ograniczony.'],
  }),
});
it('history maps both accepted sides and only actually used prior items without new quotes or scoring', async () => {
  const input = await historyFixture(),
    plan = await historyPlan(input);
  const result = await mapHistory(plan, historyResponse([relation]));
  expect(result.canonical.compared_item_ids).toEqual(['prior']);
  expect(result.canonical.relations[0]!.current_observation_refs).toEqual([
    input.current[0]!.row.observation_id,
  ]);
  expect(result.canonical.relations[0]!.prior_evidence_refs).toEqual(
    input.prior[0]!.row.evidence_ids,
  );
  expect(result.canonical.relations[0]!.relation_type).toBe('NOT_COMPARABLE');
  expect(result.semantic_verification).toBe('NOT_ASSERTED');
  const prompt = historyPromptSide(plan.snapshot.prior);
  expect(prompt[0]!.published_at).toBeNull();
  expect(prompt[0]!.qualifiers).toEqual(['warunek']);
  expect(JSON.stringify(prompt)).not.toContain(
    input.prior[0]!.row.observation_id,
  );
  expect(JSON.stringify(prompt)).not.toContain('source_artifact_id');
});
it('history refuses mixed owners, changed rows/evidence, future cut and oversized context', async () => {
  const input = await historyFixture();
  for (const change of [
    (v: typeof input) => {
      v.prior[0]!.owner_id = 'foreign';
    },
    (v: typeof input) => {
      v.prior[0]!.row.content_pl = 'Changed';
    },
    (v: typeof input) => {
      v.prior[0]!.evidence[0]!.quote_original = 'Changed';
    },
    (v: typeof input) => {
      v.prior[0]!.accepted_at = '2026-10-07T00:00:00Z';
    },
    (v: typeof input) => {
      v.prior = Array(41).fill(v.prior[0]!);
    },
  ]) {
    const changed = structuredClone(input);
    change(changed);
    await expect(historyPlan(changed)).rejects.toThrow();
  }
});
it('history rejects missing/foreign/opposite-side refs and semantic output on insufficient context', async () => {
  const input = await historyFixture(),
    plan = await historyPlan(input);
  for (const row of [
    { ...relation, prior_observation_refs: [] },
    { ...relation, prior_observation_refs: ['co1'] },
    { ...relation, current_evidence_refs: ['pe1'] },
    { ...relation, prior_evidence_refs: ['foreign'] },
    {
      ...relation,
      prior_observation_refs: ['po2'],
      prior_evidence_refs: ['pe1'],
    },
    { ...relation, scoring: 5 },
  ])
    await expect(mapHistory(plan, historyResponse([row]))).rejects.toThrow();
  await expect(
    mapHistory(plan, historyResponse([relation], 'INSUFFICIENT_CONTEXT')),
  ).rejects.toThrow('HISTORY_STATUS_MISMATCH');
  const empty = await historyPlan({ ...input, prior: [] });
  expect(
    (await mapHistory(empty, historyResponse([], 'INSUFFICIENT_CONTEXT')))
      .canonical.compared_item_ids,
  ).toEqual([]);
  await expect(mapHistory(empty, historyResponse([]))).rejects.toThrow(
    'HISTORY_STATUS_MISMATCH',
  );
});
it.each(['TRANSLATE', 'HISTORICAL_COMPARE'] as const)(
  'compiles %s as one explicit independent request with pinned template and scope',
  async (task) => {
    const family =
      task === 'TRANSLATE' ? 'FULL_TRANSLATION_V1' : 'HISTORICAL_COMPARE_V1';
    const wireId = task === 'TRANSLATE' ? 'translation-wire' : 'history-wire';
    const canonicalId = task === 'TRANSLATE' ? 'translation' : 'historical';
    const template = bundle.prompts.find((p) => p.id === family)!;
    const prompt: PromptSnapshot = {
      prompt_id: family,
      version: 2,
      prompt_hash: template.hash,
      text: template.text,
      wire: bundle.schemas.find(
        (s) => s.id === `urn:bartosz:schema:${wireId}:1.0`,
      )!,
      canonical: bundle.schemas.find(
        (s) => s.id === `urn:bartosz:schema:${canonicalId}:1.0`,
      )!,
      enrichment_version: '1.0',
      generation: 1,
    };
    const profile: PipelineProfile = {
      profile_id: 'gemini_free',
      revision: 1,
      provider_id: 'gemini',
      model: 'gemini-3.8-flash',
      account_key: 'fixture-project',
      free_eligible: true,
      billing_enabled: false,
      purposes: ['professional_single_owner'],
      regions: ['PL'],
      task_types: [task],
      runtimes: ['local'],
      structured_output: true,
      context_tokens: 100000,
      output_tokens: 8192,
      rank: 1,
      quality_approvals: [],
      eligibility_expires_at: '2026-10-08T00:00:00Z',
    };
    const input = {
      prompt,
      profile,
      runtime: 'local' as const,
      mode: 'QUALITY_TEST' as 'PRODUCTION' | 'QUALITY_TEST',
      purpose: 'professional_single_owner',
      region: 'PL',
      max_output_tokens: 1024,
      request_id: 'optional-fixture',
      now: new Date('2026-10-07T00:00:00Z'),
      deadline: '2026-10-07T00:05:00Z',
    };
    const plan =
      task === 'TRANSLATE'
        ? await translationPlan(await fixture(), 'FULL')
        : await historyPlan(await historyFixture());
    const compile = (value: typeof input) =>
      task === 'TRANSLATE'
        ? compileTranslation({
            ...value,
            plan: plan as Awaited<ReturnType<typeof translationPlan>>,
            glossary: [{ source: 'Tool X', target: 'Tool X' }],
          })
        : compileHistory({
            ...value,
            plan: plan as Awaited<ReturnType<typeof historyPlan>>,
          });
    const result = await compile(input);
    expect(result.request.wire_schema).toEqual(prompt.wire.schema);
    expect(result.request.paid_services_enabled).toBe(false);
    expect(result.request.profile.profile_id).toBe('gemini_free');
    expect(result.request.prompt).not.toMatch(/\{\{[a-z_]+\}\}/);
    expect(result.request.prompt).not.toContain('original-');
    expect(result.additional_model_requests).toBe(1);
    expect(result.selection_effect).toBe('NONE');
    await expect(compile({ ...input, mode: 'PRODUCTION' })).rejects.toThrow(
      'OPTIONAL_PROFILE_QUALITY_SCOPE',
    );
    await expect(
      compile({
        ...input,
        profile: {
          ...profile,
          eligibility_expires_at: input.now.toISOString(),
        },
      }),
    ).rejects.toThrow('OPTIONAL_PROFILE_ACCOUNT_PURPOSE_REGION');
    await expect(
      compile({ ...input, profile: { ...profile, billing_enabled: true } }),
    ).rejects.toThrow('OPTIONAL_PROFILE_FREE_ELIGIBILITY');
    await expect(
      compile({ ...input, profile: { ...profile, context_tokens: 10 } }),
    ).rejects.toThrow('OPTIONAL_PROFILE_RUNTIME_BUDGET');
    await expect(
      compile({ ...input, prompt: { ...prompt, text: 'Changed' } }),
    ).rejects.toThrow('INCOMPATIBLE_OPTIONAL_PROMPT');
  },
);
