import { expect, it } from 'vitest';
import { assessAnalysisQuality } from '../../packages/core/src/ai/quality.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { enrichEconomy } from '../../packages/core/src/ai/enrichment/canonical.js';
import {
  renderAnalysisReview,
  canonicalCitations,
} from '../../packages/core/src/export/analysis-view.js';
import {
  approvedNameNormalizer,
  resolveEntityMention,
} from '../../packages/core/src/ai/enrichment/entities.js';
import {
  analysisQualitySnapshot,
  analysisQualityPolicyV1,
  validAnalysisQualitySnapshot,
} from '../../packages/core/src/registry/analysis-quality.js';
import {
  analysisQualityScope,
  economyPromptOverhead,
} from '../../packages/core/src/ai/compiler.js';
import bundle from '../../config/registry/master-bundle.json';
import type { PromptSnapshot } from '../../packages/core/src/registry/store.js';
import type { PipelineProfile } from '../../packages/contracts/src/ai.js';

async function source(texts: string[]) {
  return normalizeTranscript(
    await sha256(texts.join('\n')),
    texts.map((text, i) => ({
      text,
      upstream_index: i,
      start_ms: i * 10000,
      end_ms: i * 10000 + 9000,
      speaker_label: null,
    })),
    'CUE',
  );
}
const empty = () => ({
  summary_pl: [] as { text_pl: string; segment_refs: string[] }[],
  key_points: [],
  entity_mentions: [],
  tools: [],
  claims: [],
  stance: [],
  predictions: [],
  source_issues: [],
});
it.each([
  [
    'Winston for sure you will go to space.',
    'Winston na pewno poleci w kosmos.',
  ],
  ['I promise you will pass the course.', 'Uczestnik na pewno zda kurs.'],
  ['Zapewniam, że na pewno będzie sukces.', 'Przedsięwzięcie odniesie sukces.'],
])(
  'holds speaker assurances stated as guaranteed events: %s',
  async (quote, text) => {
    const s = await source([quote]);
    for (const module of ['predictions', 'summary_pl', 'key_points']) {
      const wire: Parameters<typeof assessAnalysisQuality>[0] = {
        ...empty(),
        [module]: [
          {
            text_pl: text,
            segment_refs: ['s1'],
            attribution: 'SOURCE_SPEAKER',
          },
        ],
      };
      expect(
        assessAnalysisQuality(wire, s.manifest.anchors).findings.map(
          (f) => f.code,
        ),
      ).toContain('SPEAKER_ASSURANCE_AS_GUARANTEE');
      wire[module]![0]!.text_pl =
        'Rozmówca optymistycznie zapewnia o przyszłym sukcesie; jego zapewnienie nie jest gwarancją wydarzenia.';
      expect(assessAnalysisQuality(wire, s.manifest.anchors).status).toBe(
        'PASS',
      );
    }
  },
);
it.each([
  [
    'That talk has become one of our most viewed talks of 2026 so far.',
    'Wystąpienie należy do najpopularniejszych w 2026 roku.',
  ],
  ['Currently we serve 100 schools.', 'Firma obsługuje 100 szkół.'],
  ['As of June 2030, we ranked first.', 'Zajmujemy pierwsze miejsce.'],
  [
    'Program jest obecnie dostępny bezpłatnie.',
    'Program jest zawsze bezpłatny.',
  ],
])(
  'holds lost temporal scope in unrelated subjects: %s',
  async (quote, text) => {
    const s = await source([quote]);
    const wire = {
      ...empty(),
      claims: [
        {
          text_pl: text,
          segment_refs: ['s1'],
          attribution: 'SOURCE_SPEAKER',
          qualifiers: [] as string[],
        },
      ],
    };
    expect(
      assessAnalysisQuality(wire, s.manifest.anchors).findings.map(
        (f) => f.code,
      ),
    ).toContain('SOURCE_TEMPORAL_SCOPE_LOST');
    wire.claims[0]!.text_pl = 'Według rozmówcy, na moment rozmowy: ' + text;
    expect(assessAnalysisQuality(wire, s.manifest.anchors).status).toBe('PASS');
    wire.claims[0]!.text_pl = text;
    wire.claims[0]!.qualifiers = ['Według stanu na czerwiec 2030.'];
    expect(assessAnalysisQuality(wire, s.manifest.anchors).status).toBe('PASS');
  },
);
it('does not demand time or assurance qualifiers for an unqualified source fact', async () => {
  const s = await source(['Water freezes at the specified pressure.']);
  expect(
    assessAnalysisQuality(
      {
        ...empty(),
        claims: [
          {
            text_pl: 'Woda zamarza przy podanym ciśnieniu.',
            segment_refs: ['s1'],
          },
        ],
      },
      s.manifest.anchors,
    ).status,
  ).toBe('PASS');
});
it('does not treat an explicitly uncertain forecast as a guarantee because a wider source span also says for sure', async () => {
  const s = await source([
    'For sure we like exploration. I think we will arrive in 2040.',
  ]);
  const wire = {
    ...empty(),
    predictions: [
      {
        text_pl: 'Rozmówca uważa, że w 2040 może dojść do podróży.',
        segment_refs: ['s1'],
      },
    ],
  };
  expect(assessAnalysisQuality(wire, s.manifest.anchors).status).toBe('PASS');
  wire.predictions[0]!.text_pl =
    'Według rozmówcy podróż na pewno nastąpi w 2040.';
  expect(
    assessAnalysisQuality(wire, s.manifest.anchors).findings.map((f) => f.code),
  ).toContain('SPEAKER_ASSURANCE_AS_GUARANTEE');
});
it('preserves exact old policy pins while rejecting modified or unknown policies', async () => {
  const old = {
    ...analysisQualityPolicyV1,
    hash: await sha256(JSON.stringify(analysisQualityPolicyV1)),
  };
  const current = await analysisQualitySnapshot();
  expect(current.version).toBe('analysis-quality:2');
  expect(await validAnalysisQualitySnapshot(old)).toBe(true);
  expect(await validAnalysisQualitySnapshot(current)).toBe(true);
  expect(
    await validAnalysisQualitySnapshot({
      ...old,
      text: old.text + ' injected instruction',
    }),
  ).toBe(false);
  expect(
    await validAnalysisQualitySnapshot({
      ...current,
      version: 'analysis-quality:3',
    }),
  ).toBe(false);
});
it.each([
  [
    '2040. I I think we will be on Mars.',
    'Ludzie znajdą się na Marsie przed rokiem 2040.',
    '2040',
  ],
  [
    'Maybe the prototype will be ready in 2032 if funding arrives.',
    'Prototyp będzie gotowy przed 2032.',
    '2032',
  ],
  [
    'Sądzę, że wynik może wzrosnąć w 2035, jeśli testy się powiodą.',
    'Wynik wzrośnie przed 2035.',
    '2035',
  ],
])(
  'holds strengthened deadlines and lost uncertainty across languages: %s',
  async (quote, text, horizon) => {
    const s = await source([quote]);
    const wire = {
      ...empty(),
      predictions: [
        {
          text_pl: text,
          horizon,
          qualifiers: [] as string[],
          segment_refs: ['s1'],
          attribution: 'SOURCE_SPEAKER',
        },
      ],
    };
    const audit = assessAnalysisQuality(wire, s.manifest.anchors);
    expect(audit.status).toBe('REVIEW_REQUIRED');
    expect(audit.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining([
        'SOURCE_QUALIFIER_LOST',
        'DEADLINE_STRENGTHENED',
      ]),
    );
    wire.predictions[0]!.text_pl = `Według rozmówcy jest to prognoza na ${horizon}; wynik może zależeć od warunków.`;
    wire.predictions[0]!.qualifiers = ['Niepewna prognoza rozmówcy.'];
    expect(assessAnalysisQuality(wire, s.manifest.anchors).status).toBe('PASS');
  },
);
it('allows an actually stated before-year deadline and flags unresolved attribution', async () => {
  const s = await source(['We will finish before 2030.']);
  const wire = {
    ...empty(),
    claims: [
      {
        text_pl: 'Autor zapowiada zakończenie przed 2030.',
        segment_refs: ['s1'],
        attribution: 'SOURCE_SPEAKER',
      },
    ],
  };
  expect(assessAnalysisQuality(wire, s.manifest.anchors).status).toBe('PASS');
  wire.claims[0]!.attribution = 'UNCLEAR';
  expect(
    assessAnalysisQuality(wire, s.manifest.anchors).findings[0]!.code,
  ).toBe('UNRESOLVED_ATTRIBUTION');
});
it('detects unrepresented late sections without accepting foreign refs as coverage', async () => {
  const s = await source(
    Array.from(
      { length: 32 },
      (_, i) =>
        `Section ${i}: ${'Substantive discussion of a different process. '.repeat(4)}`,
    ),
  );
  const wire = empty();
  wire.summary_pl = [
    { text_pl: 'Autor omawia początek.', segment_refs: ['s1'] },
  ];
  expect(
    assessAnalysisQuality(wire, s.manifest.anchors).coverage_windows.filter(
      (w) => !w.covered,
    ).length,
  ).toBe(7);
  wire.summary_pl = Array.from({ length: 8 }, (_, i) => ({
    text_pl: `Autor omawia część ${i}.`,
    segment_refs: [`s${i * 4 + 3}`],
  }));
  expect(assessAnalysisQuality(wire, s.manifest.anchors).status).toBe('PASS');
  wire.summary_pl.at(-1)!.segment_refs = ['foreign'];
  expect(
    assessAnalysisQuality(wire, s.manifest.anchors).findings.map((f) => f.code),
  ).toContain('FOREIGN_SOURCE_REF');
  expect(
    assessAnalysisQuality(
      { ...wire, summary_pl: wire.summary_pl.slice(0, 1) },
      s.manifest.anchors,
      { coverage: false },
    ).findings,
  ).toEqual([]);
});
it.each(['undefined', 'null', '[object Object]', 'NaN', ''])(
  'rejects broken display text: %s',
  async (text) => {
    const s = await source(['Original source statement.']);
    expect(
      assessAnalysisQuality(
        { ...empty(), summary_pl: [{ text_pl: text, segment_refs: ['s1'] }] },
        s.manifest.anchors,
      ).findings[0]!.code,
    ).toBe('BROKEN_CONTENT');
  },
);
it('normalizes only approved unambiguous names with owner/type/language isolation and no cascading', async () => {
  const input = {
    owner_id: 'a',
    source_artifact_id: 's',
    mention_index: 0,
    label: 'Acme labb',
    entity_type: 'ORG' as const,
    language: 'en',
    aliases: [
      {
        owner_id: 'a',
        entity_id: 'e',
        entity_type: 'ORG' as const,
        literal: 'Acme labb',
        canonical_label: 'Acme Labs',
        language: 'en',
      },
    ],
  };
  expect(await resolveEntityMention(input)).toMatchObject({
    label: 'Acme Labs',
    resolution: 'APPROVED_ALIAS',
  });
  expect(await resolveEntityMention({ ...input, owner_id: 'b' })).toMatchObject(
    { label: 'Acme labb', resolution: 'UNRESOLVED_LITERAL' },
  );
  expect(
    await resolveEntityMention({ ...input, language: 'pl' }),
  ).toMatchObject({ label: 'Acme labb', resolution: 'UNRESOLVED_LITERAL' });
  expect(
    await resolveEntityMention({
      ...input,
      aliases: [
        ...input.aliases,
        { ...input.aliases[0]!, canonical_label: 'Other Labs' },
      ],
    }),
  ).toMatchObject({ resolution: 'AMBIGUOUS_LITERAL', label: 'Acme labb' });
  const normalize = approvedNameNormalizer([
    { literal: 'Acme labb', label: 'Acme Labs' },
    { literal: 'Acme Labs', label: 'Other' },
    { literal: 'X', label: 'Y' },
    { literal: 'X', label: 'Z' },
  ]);
  expect(normalize('Acme labb; X; Acme labbing')).toBe(
    'Acme Labs; X; Acme labbing',
  );
});
it('renders canonical content_pl, all ten typed texts and qualifiers with exact links; preserves source and raw wire', async () => {
  const s = await source([
    'Acme labb reports a trial, not proven effectiveness.',
  ]);
  const row = {
    text_pl: 'Acme labb opisuje próbę.',
    segment_refs: ['s1'],
    entity_refs: [0],
    subject_ref: 0,
    attribution: 'SOURCE_SPEAKER',
    qualifiers: ['nie potwierdzona skuteczność'],
  };
  const wire = {
    ...empty(),
    summary_pl: [{ text_pl: row.text_pl, segment_refs: row.segment_refs }],
    entity_mentions: [
      { label: 'Acme labb', entity_type: 'ORG', segment_refs: ['s1'] },
    ],
    claims: Array.from({ length: 7 }, (_, i) => ({
      ...row,
      text_pl: `Acme labb: twierdzenie ${i}.`,
    })),
    predictions: Array.from({ length: 3 }, (_, i) => ({
      ...row,
      text_pl: `Acme labb: prognoza ${i}.`,
      horizon: null,
    })),
  };
  const raw = JSON.stringify(wire),
    originalSource = JSON.stringify(s);
  const enriched = await enrichEconomy({
    raw,
    completion: 'OK',
    run_id: 'run',
    item_id: 'abcdefghijk',
    profile_id: 'ECONOMY',
    profile_revision: '1',
    source: {
      owner_id: 'a',
      source_artifact_id: 's',
      ...s,
      video_url: 'https://www.youtube.com/watch?v=abcdefghijk',
    },
    approved_aliases: [
      {
        owner_id: 'a',
        entity_id: 'e',
        entity_type: 'ORG',
        literal: 'Acme labb',
        canonical_label: 'Acme Labs',
      },
    ],
  });
  const c = enriched.canonical;
  expect(c.summary_pl[0]!.text_pl).toBe('Acme Labs opisuje próbę.');
  const markdown = renderAnalysisReview(
    c,
    'https://www.youtube.com/watch?v=abcdefghijk',
  );
  for (const unit of [...c.claims, ...c.predictions])
    expect(markdown).toContain(unit.content_pl);
  expect(markdown).toContain('nie potwierdzona skuteczność');
  expect(markdown.replaceAll('\\_', '_')).toContain('SOURCE_STATEMENT');
  expect(markdown).toContain(
    'https://www.youtube.com/watch?v=abcdefghijk&t=0s',
  );
  expect(markdown).not.toContain('undefined');
  expect(JSON.stringify(wire)).toBe(raw);
  expect(JSON.stringify(s)).toBe(originalSource);
  expect(c.evidence[0]!.quote_original).toContain('Acme labb');
  expect(() =>
    canonicalCitations(
      c,
      c.claims[0]!.evidence_ids,
      'https://www.youtube.com/watch?v=bcdefghijkl',
    ),
  ).toThrow('EXPORT_EVIDENCE_LOCATOR_MISMATCH');
  c.claims[0]!.content_pl = 'undefined';
  expect(() =>
    renderAnalysisReview(c, 'https://www.youtube.com/watch?v=abcdefghijk'),
  ).toThrow('BROKEN_ANALYSIS_CONTENT');
});
it('binds the additive Registry quality template to scope and token overhead without mutating immutable v2', async () => {
  const base = bundle.prompts[0]!;
  const wire = bundle.schemas.find((s) => s.id.endsWith('economy-wire:1.0'))!;
  const canonical = bundle.schemas[0]!;
  const prompt: PromptSnapshot = {
    prompt_id: base.id,
    version: base.version,
    text: base.text,
    prompt_hash: base.hash,
    wire,
    canonical,
    enrichment_version: '1.0',
    generation: 1,
  };
  const next = { ...prompt, quality_policy: await analysisQualitySnapshot() };
  const profile = {
    provider_id: 'gemini',
    model: 'fixture',
  } as PipelineProfile;
  const settings = {
    limits: {},
    max_output_tokens: 4096,
    source_language: 'en',
    analysis_mode: 'ORDINARY' as const,
  };
  expect(await analysisQualityScope(next, profile, settings)).not.toBe(
    await analysisQualityScope(prompt, profile, settings),
  );
  const semantic_context = {
    title: null,
    author: null,
    published_at: null,
    source_language: 'en',
  };
  expect(
    economyPromptOverhead({ prompt: next, semantic_context, limits: {} }),
  ).toBeGreaterThan(
    economyPromptOverhead({ prompt, semantic_context, limits: {} }),
  );
  expect(base.hash).toBe(await sha256(prompt.text));
});
