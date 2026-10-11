import { expect, it } from 'vitest';
import { summaryNarrative } from '../../packages/contracts/src/narrative.js';
import { assessSummaryNarrative } from '../../packages/core/src/ai/narrative-quality.js';
import { assessAnalysisQuality } from '../../packages/core/src/ai/quality.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import bundle from '../../config/registry/master-bundle.json';
import {
  compileEconomy,
  economyPromptOverhead,
  economyChunkContextHash,
} from '../../packages/core/src/ai/compiler.js';
import { createChunkPlan } from '../../packages/core/src/ai/long-input/plan.js';
import { mergeChunkOutputs } from '../../packages/core/src/ai/long-input/merge.js';
import type { PromptSnapshot } from '../../packages/core/src/registry/store.js';
import type { PipelineProfile } from '../../packages/contracts/src/ai.js';
import {
  analysisQualityPolicyV1,
  analysisQualityPolicyV2,
  analysisQualitySnapshot,
  validAnalysisQualitySnapshot,
} from '../../packages/core/src/registry/analysis-quality.js';

// Authored golden examples, not model outputs or production quality evidence.
// Assert useful details and source boundaries, never equate format with truth.
const examples = [
  {
    kind: 'short science',
    source: [
      'In this experiment the membrane passed water but retained salt.',
      'The test lasted two hours. Long-term durability has not been tested.',
    ],
    summary: [
      'W doświadczeniu membrana przepuszczała wodę, zatrzymując sól. Próba trwała dwie godziny.',
      'Nie zbadano trwałości materiału podczas długiego użytkowania, więc wynik dotyczy jedynie krótkiego testu.',
    ],
    details: [
      'membrana',
      'zatrzymując sól',
      'dwie godziny',
      'Nie zbadano trwałości',
    ],
  },
  {
    kind: 'medium technical',
    source: [
      'The team replaced full scans with indexed lookups. Each request now touches the matching key rather than all records. Reads fell from 12000 to 40 in our benchmark.',
      'Retries use the same operation identifier. A crash after saving cannot create another document. The readback checks all bytes and the digest.',
      'The measurements concern this benchmark dataset, not every installation. The ending recommends testing the recovery path before increasing concurrency.',
    ],
    summary: [
      'Zespół zastąpił pełne skanowanie tabel wyszukiwaniem po indeksie. Zapytanie odnajduje pasujący klucz, zamiast przeglądać wszystkie rekordy; według autorów w ich benchmarku liczba odczytów spadła z 12 tysięcy do 40.',
      'Ponowienia zachowują identyfikator operacji, dlatego awaria po zapisie nie tworzy drugiego dokumentu. Odczyt kontrolny porównuje wszystkie bajty i skrót danych.',
      'Wynik dotyczy badanego zbioru, a nie każdej instalacji. Przed zwiększeniem liczby równoległych zadań autorzy zalecają sprawdzenie odtwarzania po awarii.',
    ],
    details: [
      '12 tysięcy do 40',
      'pasujący klucz',
      'identyfikator operacji',
      'nie każdej instalacji',
      'odtwarzania po awarii',
    ],
  },
  {
    kind: 'news',
    source: [
      'The mayor says the new line serves 40 percent of residents as of this conversation.',
      'Construction will start in 2028 if funding is approved. The final question addresses accessibility: every stop is planned to have a lift.',
    ],
    summary: [
      'Burmistrz deklaruje, że według stanu na moment rozmowy nowa linia obsługuje 40 procent mieszkańców.',
      'Budowa kolejnego odcinka ma ruszyć w 2028 roku, jeśli zostanie przyznane finansowanie. Projekt przewiduje windę na każdym przystanku, co ma ułatwić korzystanie z linii osobom o ograniczonej mobilności.',
    ],
    details: [
      'Burmistrz deklaruje',
      'na moment rozmowy',
      '40 procent',
      'jeśli',
      'windę na każdym przystanku',
    ],
  },
  {
    kind: 'interview',
    source: [
      'The researcher thinks a mission could launch in 2040. This is a forecast.',
      'We begin with cheap prototypes and compare failed attempts to identify the mechanism. A later discussion explains how individual feedback can support education.',
      'I promise this will succeed for sure.',
    ],
    summary: [
      'Badacz przypuszcza, że misja mogłaby wystartować w 2040 roku; jest to jego prognoza.',
      'Zespół zaczyna od tanich prototypów i porównuje nieudane próby, aby ustalić mechanizm działania. Indywidualna informacja zwrotna ma pomagać uczniom rozpoznawać własne błędy.',
      'Rozmówca optymistycznie zapewnia o przyszłym sukcesie, co nie jest gwarancją wydarzenia.',
    ],
    details: [
      'przypuszcza',
      '2040',
      'tanich prototypów',
      'Indywidualna informacja',
      'nie jest gwarancją',
    ],
  },
];
it.each(examples)(
  'retains specific source-backed knowledge in a $kind paragraph without padding',
  async (example) => {
    const source = await normalizeTranscript(
      await sha256(example.source.join('\n')),
      example.source.map((text, i) => ({
        text,
        upstream_index: i,
        start_ms: i * 60000,
        end_ms: i * 60000 + 59000,
        speaker_label: null,
      })),
      'CUE',
    );
    const notes = example.summary.map((text_pl, i) => ({
      text_pl,
      segment_refs: [source.manifest.anchors[i]!.alias],
    }));
    const before = JSON.stringify({ notes, source });
    const narrative = summaryNarrative(notes);
    for (const detail of example.details) expect(narrative).toContain(detail);
    expect(narrative).not.toMatch(/[\r\n]|https?:|\[\d+:\d+\]/u);
    const report = assessAnalysisQuality(
      { summary_pl: notes },
      source.manifest.anchors,
      { radio: true },
    );
    expect(report.status).toBe('PASS');
    expect(report.narrative?.information_density).toBe('NOT_ASSERTED');
    expect(report.semantic_verification).toBe('NOT_ASSERTED');
    expect(JSON.stringify({ notes, source })).toBe(before);
  },
);

it.each([
  '- Pierwszy punkt.',
  '1. Pierwszy punkt.',
  '## Temat',
  '| pole | wartość |',
  'Źródło https://example.invalid.',
  'Wynik [źródło](https://example.invalid).',
  'Wskazanie [12:34] albo 00:12:34.',
  'Odwołanie segment_refs s123.',
  'Wynik **wyróżniony**.',
  '<b>Wynik</b>',
])(
  'holds formatting or technical debris in future narrative: %s',
  (text_pl) => {
    expect(assessSummaryNarrative([{ text_pl }]).findings).toContain(
      'NARRATIVE_FORMAT',
    );
  },
);
it('flags teasers, filler and exact sentence repetition without deleting source-grounded content', () => {
  const text_pl =
    'W tym filmie autor opowiada o technologii. Warto obejrzeć ten film. Membrana zatrzymuje sól, przepuszczając wodę. Membrana zatrzymuje sól, przepuszczając wodę.';
  expect(assessSummaryNarrative([{ text_pl }]).findings).toEqual([
    'NARRATIVE_TEASER',
    'NARRATIVE_FILLER',
    'NARRATIVE_REPETITION',
  ]);
  expect(summaryNarrative([{ text_pl }])).toBe(text_pl);
});
it.each([
  'Amazon S3 przechowuje obiekty, a odczyt kontrolny porównuje ich skróty.',
  'Zestaw EV3 pozwala uczniom programować roboty i badać ruch silników.',
])(
  'keeps source product names distinct from case-sensitive wire aliases: %s',
  (text_pl) => {
    expect(assessSummaryNarrative([{ text_pl }]).findings).toEqual([]);
    expect(summaryNarrative([{ text_pl }])).toBe(text_pl);
  },
);
it.each(['Wskazanie s1.', 'Wskazanie ev123.'])(
  'holds leaked lowercase technical aliases: %s',
  (text_pl) => {
    expect(assessSummaryNarrative([{ text_pl }]).findings).toContain(
      'NARRATIVE_FORMAT',
    );
  },
);
it.each([40, 210, 320, 400])(
  'treats %s words as guidance rather than a word-count acceptance proof',
  (count) => {
    const notes = [
      {
        text_pl: Array.from({ length: count }, (_, i) => `termin${i}`).join(
          ' ',
        ),
      },
    ];
    expect(assessSummaryNarrative(notes)).toMatchObject({
      word_count: count,
      length_is_acceptance_gate: false,
      information_density: 'NOT_ASSERTED',
    });
    expect(summaryNarrative(notes).split(' ')).toHaveLength(count);
  },
);
it('requires later source coverage in narrative itself, not only secondary key points', async () => {
  const normalized = await normalizeTranscript(
    await sha256('long golden'),
    Array.from({ length: 32 }, (_, i) => ({
      text:
        `Topic ${i}: ` +
        'A substantive explanation of the mechanism and its limits. '.repeat(4),
      upstream_index: i,
      start_ms: i * 10000,
      end_ms: i * 10000 + 9000,
      speaker_label: null,
    })),
    'CUE',
  );
  const all = normalized.manifest.anchors;
  const start = all[0]!.source_start,
    end = all.at(-1)!.source_end;
  const rows = Array.from({ length: 8 }, (_, i) => ({
    text_pl: `Rozmówca wyjaśnia mechanizm ${i} i jego ograniczenia.`,
    segment_refs: [
      all.find(
        (anchor) =>
          anchor.source_start >= start + ((i + 0.5) * (end - start)) / 8,
      )!.alias,
    ],
  }));
  const wire = { summary_pl: rows.slice(0, 1), key_points: rows.slice(1) };
  expect(assessAnalysisQuality(wire, all).status).toBe('PASS');
  expect(
    assessAnalysisQuality(wire, all, { radio: true }).findings,
  ).toContainEqual({
    code: 'NARRATIVE_COVERAGE_GAP',
    module: 'summary_pl',
    index: 7,
  });
  expect(
    assessAnalysisQuality({ summary_pl: rows }, all, { radio: true }).status,
  ).toBe('PASS');
  expect(summaryNarrative(rows)).toContain('mechanizm 7');
});
it('holds broken narrative for review rather than throwing a retryable processing error', () => {
  expect(
    assessAnalysisQuality(
      { summary_pl: [{ text_pl: 'undefined', segment_refs: [] }] },
      [],
      { radio: true },
    ),
  ).toMatchObject({
    status: 'REVIEW_REQUIRED',
    findings: [{ code: 'BROKEN_CONTENT', module: 'summary_pl', index: 0 }],
  });
});

it('does not claim semantic information density for padding, omitted central facts or unsupported detail with valid-looking references', async () => {
  const source = await normalizeTranscript(
    await sha256('synthetic contrast'),
    [
      {
        text: 'The membrane retained salt. This short experiment does not establish long-term durability.',
        upstream_index: 0,
        start_ms: 0,
        end_ms: 10000,
        speaker_label: null,
      },
    ],
    'CUE',
  );
  const contrasts = [
    Array.from({ length: 210 }, (_, i) => `ogólnik${i}`).join(' '),
    'Badanie dotyczyło krótkiego doświadczenia z membraną.',
    'Membrana zapewnia skuteczność 99 procent przez dziesięć lat.',
  ];
  for (const text_pl of contrasts) {
    const report = assessAnalysisQuality(
      { summary_pl: [{ text_pl, segment_refs: ['s1'] }] },
      source.manifest.anchors,
      { radio: true },
    );
    // These counterexamples pass structural checks. Neither a plausible ref
    // nor the word guidance proves the central fact, entailment or density.
    expect(report.semantic_verification).toBe('NOT_ASSERTED');
    expect(report.narrative?.information_density).toBe('NOT_ASSERTED');
    expect(report.narrative?.length_is_acceptance_gate).toBe(false);
  }
  const foreign = assessAnalysisQuality(
    { summary_pl: [{ text_pl: contrasts[2]!, segment_refs: ['s999'] }] },
    source.manifest.anchors,
    { radio: true },
  );
  expect(foreign.status).toBe('REVIEW_REQUIRED');
  expect(foreign.findings.map((finding) => finding.code)).toContain(
    'FOREIGN_SOURCE_REF',
  );
});

it('holds a distorted forecast even when its narrative has the standard word count', async () => {
  const source = await normalizeTranscript(
    await sha256('synthetic forecast'),
    [
      {
        text: 'I think we will reach Mars in 2040.',
        upstream_index: 0,
        start_ms: 0,
        end_ms: 10000,
        speaker_label: null,
      },
    ],
    'CUE',
  );
  const text_pl =
    'Podróż nastąpi przed 2040. ' +
    Array.from({ length: 206 }, (_, i) => `opis${i}`).join(' ');
  const report = assessAnalysisQuality(
    { summary_pl: [{ text_pl, segment_refs: ['s1'] }] },
    source.manifest.anchors,
    { radio: true },
  );
  expect(report.narrative?.length_guidance).toBe('STANDARD');
  expect(report.status).toBe('REVIEW_REQUIRED');
  expect(report.findings.map((finding) => finding.code)).toEqual(
    expect.arrayContaining(['DEADLINE_STRENGTHENED', 'SOURCE_QUALIFIER_LOST']),
  );
});

it('checks chunk boundaries for repeated sentences without rewriting immutable child outputs or invoking a synthesis', async () => {
  const source = await normalizeTranscript(
    await sha256('synthetic multi-section source'),
    Array.from({ length: 12 }, (_, i) => ({
      text: `Section ${i}: The membrane retained salt in a short laboratory test.`,
      upstream_index: i,
      start_ms: i * 10000,
      end_ms: i * 10000 + 9000,
      speaker_label: null,
    })),
    'CUE',
  );
  const plan = await createChunkPlan({
    ...source,
    context_hash: 'a'.repeat(64),
    context_tokens: 480,
    output_tokens: 80,
    prompt_overhead_tokens: 100,
    maximum_overlap_segments: 1,
  });
  expect(plan.plan.chunks.length).toBeGreaterThan(1);
  const outputs = plan.plan.chunks.map((chunk) => ({
    chunk_index: chunk.chunk_index,
    completion: 'OK' as const,
    raw: JSON.stringify({
      summary_pl: [
        {
          text_pl: 'Membrana zatrzymuje sól w krótkiej próbie laboratoryjnej.',
          segment_refs: [
            chunk.aliases.find(
              (row) => row.segment_id === chunk.primary_segment_ids[0],
            )!.alias,
          ],
        },
      ],
      key_points: [],
      entity_mentions: [],
      tools: [],
      claims: [],
      stance: [],
      predictions: [],
      source_issues: [],
    }),
  }));
  const before = JSON.stringify(outputs);
  const merged = await mergeChunkOutputs({ ...source, ...plan, outputs });
  const report = assessAnalysisQuality(
    merged.wire as Parameters<typeof assessAnalysisQuality>[0],
    source.manifest.anchors,
    { radio: true },
  );
  expect(merged.coverage.complete).toBe(true);
  expect(merged.wire.summary_pl).toHaveLength(outputs.length);
  expect(report.status).toBe('REVIEW_REQUIRED');
  expect(report.findings.map((finding) => finding.code)).toContain(
    'NARRATIVE_REPETITION',
  );
  expect(merged.additional_model_requests).toBe(0);
  expect(JSON.stringify(outputs)).toBe(before);
});
it('keeps exact historical policies readable and binds the new default without changing their pins', async () => {
  for (const policy of [analysisQualityPolicyV1, analysisQualityPolicyV2])
    expect(
      await validAnalysisQualitySnapshot({
        ...policy,
        hash: await sha256(JSON.stringify(policy)),
      }),
    ).toBe(true);
  const policy = await analysisQualitySnapshot();
  expect(policy.version).toBe('analysis-quality:3');
  expect(policy.text).toContain('180–260');
  expect(policy.text).toContain('ONE coherent spoken paragraph');
  expect(policy.text).toContain('key_points alone do not satisfy');
  expect(await validAnalysisQualitySnapshot(policy)).toBe(true);
});
it('shares film-level guidance across long-input parts within the existing bounded context', async () => {
  const cues = Array.from({ length: 40 }, (_, i) => ({
    text:
      `Mechanism ${i}: ` +
      'The mechanism reduces reads by addressing a matching key, subject to this dataset. '.repeat(
        2,
      ),
    upstream_index: i,
    start_ms: i * 10000,
    end_ms: i * 10000 + 9000,
    speaker_label: null,
  }));
  const source = await normalizeTranscript(
    await sha256(cues.map((row) => row.text).join('\n')),
    cues,
    'CUE',
  );
  const base = bundle.prompts.find((row) => row.id === 'ECONOMY_ANALYSIS_V1')!;
  const prompt: PromptSnapshot = {
    prompt_id: base.id,
    version: base.version,
    text: base.text,
    prompt_hash: base.hash,
    wire: bundle.schemas.find((row) => row.id.endsWith('economy-wire:1.0'))!,
    canonical: bundle.schemas.find((row) =>
      row.id.endsWith('intelligence-canonical:1.2'),
    )!,
    enrichment_version: '1.0',
    generation: 1,
    quality_policy: await analysisQualitySnapshot(),
  };
  const semantic_context = {
    title: 'Long technical fixture',
    author: null,
    published_at: null,
    source_language: 'en',
  };
  const overhead = economyPromptOverhead({
    prompt,
    semantic_context,
    limits: {},
  });
  const profile = {
    provider_id: 'gemini',
    model: 'fixture',
    context_tokens: overhead + 1024 + 1700,
    output_tokens: 1024,
  } as PipelineProfile;
  const input = {
    source_artifact_id: 'source',
    ...source,
    prompt,
    profile,
    profile_revision: '1',
    semantic_context,
    runtime: 'local' as const,
    request_id: 'offline-fixture',
    deadline: '2026-10-11T23:59:00Z',
    mode: 'QUALITY_TEST' as const,
    max_output_tokens: 1024,
    limits: {},
  };
  const built = await createChunkPlan({
    ...source,
    context_hash: await economyChunkContextHash(input),
    context_tokens: profile.context_tokens,
    output_tokens: 1024,
    prompt_overhead_tokens: overhead,
  });
  expect(built.plan.chunks.length).toBeGreaterThan(1);
  for (const part of built.plan.chunks) {
    const compiled = await compileEconomy({
      ...input,
      chunk: { ...built, chunk_index: part.chunk_index },
    });
    expect(compiled.request.prompt).toContain(
      `"parts":${built.plan.chunks.length}`,
    );
    expect(compiled.request.prompt).toContain(
      `"suggested_part_words":${Math.ceil(260 / built.plan.chunks.length)}`,
    );
    expect(
      compiled.request.estimated_input_tokens +
        compiled.request.max_output_tokens,
    ).toBeLessThanOrEqual(profile.context_tokens);
    expect(compiled.request.paid_services_enabled).toBe(false);
  }
});
