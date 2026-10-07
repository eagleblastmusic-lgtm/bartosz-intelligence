import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import bundle from '../../config/registry/master-bundle.json';
import {
  compileSemanticProfile,
  semanticModules,
  type SemanticProfile,
} from '../../packages/core/src/ai/semantic-profile.js';
import { enrichSemantic } from '../../packages/core/src/ai/enrichment/canonical.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import {
  renderDaily,
  type DailyRenderInput,
} from '../../packages/core/src/export/renderer.js';
import type { DailyItemView } from '../../packages/contracts/src/daily.js';
import { materialReport } from '../../packages/core/src/export/material.js';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
it('renders Warsaw time without relabelling UTC and associates FULL units with their canonical Evidence', async () => {
  const input = await fixture(undefined, true);
  input.mode = 'FULL';
  const report = await renderDaily(input),
    c = input.selections[0]!.canonical;
  expect(report.markdown).toContain(
    'Publikacja: 2026-10-07 11:00:00 Europe/Warsaw; źródłowy timestamp: 2026-10-07T09:00:00Z',
  );
  for (const row of [
    ...c.summary_pl,
    ...c.key_points,
    ...c.tools,
    ...c.entities,
    ...c.claims,
  ]) {
    for (const id of row.evidence_ids)
      expect(report.markdown).toContain(id.replaceAll('_', '\\_'));
  }
  expect(report.markdown).toContain('Evidence refs: ');
  expect(report.markdown).toContain('Observation: ');
  expect(report.markdown).toContain('Narzędzie: Tool X');
  expect(report.markdown).toContain(
    '#observation-' + c.claims[0]!.observation_id,
  );
  expect(report.markdown).not.toContain('#observation=');
  expect(c.summary_pl[0]!.evidence_ids).not.toEqual(
    c.summary_pl[1]!.evidence_ids,
  );
  const decoded = report.markdown.replaceAll('\\_', '_');
  for (const row of c.summary_pl)
    expect(decoded).toContain(
      `Podsumowanie: ${row.text_pl}\n  Evidence refs: ${row.evidence_ids.join('; ')}`,
    );
});
it('ignores only envelope bookkeeping while preserving mode, counts, warnings and source bytes', async () => {
  const input = await fixture();
  const first = await renderDaily(input);
  input.revision++;
  input.snapshot.cut_seq++;
  const next = await renderDaily(input);
  expect(first.content_hash).not.toBe(next.content_hash);
  expect(materialReport(first.markdown)).toBe(materialReport(next.markdown));
  for (const changed of [
    next.markdown.replace('export_mode: COMPACT', 'export_mode: FULL'),
    next.markdown.replace(
      'discovery_coverage: incomplete',
      'discovery_coverage: complete',
    ),
    next.markdown.replace(
      'bridge_size_state: WITHIN_ESTIMATE',
      'bridge_size_state: OVERSIZE',
    ),
    next.markdown.replace('Żółć', 'Zmieniona treść'),
    next.markdown.replace('item_count=4', 'item_count=5'),
  ]) {
    expect(changed).not.toBe(next.markdown);
    expect(materialReport(changed)).not.toBe(materialReport(first.markdown));
  }
  expect(() =>
    materialReport(next.markdown.replace(/revision=\d+/, 'revision=999')),
  ).toThrow('EXPORT_PROTOCOL_INVALID');
});
async function fixture(selected?: string[], separateEvidence = false) {
  const profile = await compileSemanticProfile(
    {
      mode: selected ? 'CUSTOM' : 'FULL',
      modules: Object.fromEntries(
        semanticModules.map((key) => [
          key,
          !selected || selected.includes(key),
        ]),
      ) as SemanticProfile['modules'],
      translation: 'NONE',
      history: false,
      second_pass: null,
      validation_pass: null,
    },
    bundle,
  );
  const source = await normalizeTranscript(
    hash(
      'I did not adopt Tool X; only 20% if tested.' +
        (separateEvidence ? '\nStill evaluating.' : ''),
    ),
    [
      {
        upstream_index: 0,
        text: 'I did not adopt Tool X; only 20% if tested.',
        start_ms: null,
        end_ms: null,
        speaker_label: null,
      },
      ...(separateEvidence
        ? [
            {
              upstream_index: 1,
              text: 'Still evaluating.',
              start_ms: null,
              end_ms: null,
              speaker_label: null,
            },
          ]
        : []),
    ],
    'CUE',
  );
  const claim = {
    text_pl: 'Autor nie wdrożył Tool X; tylko 20% pod warunkiem testu.',
    segment_refs: ['s1'],
    entity_refs: [0],
    subject_ref: null,
    attribution: 'SOURCE_SPEAKER',
    qualifiers: ['tylko 20%', 'pod warunkiem testu'],
  };
  const wire: Record<string, unknown> = {
    summary_pl: ['Żółć 🧠 — nie wdrożył.', 'Druga pełna notatka.'].map(
      (text_pl, index) => ({
        text_pl,
        segment_refs: [separateEvidence && index === 1 ? 's2' : 's1'],
      }),
    ),
    key_points: [1, 2, 3, 4].map((n) => ({
      text_pl: `Pełny punkt ${n} z negacją: nie.`,
      segment_refs: ['s1'],
    })),
    entity_mentions: [
      { label: 'Tool X', entity_type: 'TOOL', segment_refs: ['s1'] },
    ],
    tools: [
      {
        entity_ref: 0,
        context_pl: 'Tylko wypróbowane, nie wdrożone.',
        segment_refs: ['s1'],
      },
    ],
    claims: [claim],
    stance: [
      {
        ...claim,
        text_pl: 'Autor przytacza opinię innej osoby.',
        attribution: 'REPORTED_OTHER',
        polarity: 'NEGATIVE',
        target_ref: 0,
      },
    ],
    predictions: [{ ...claim, horizon: 'za rok' }],
    usage: [],
    recommendations: [],
    uncertainties: [],
    contradictions: [
      {
        left: { module: 'claims', index: 0 },
        right: { module: 'stance', index: 0 },
        explanation_pl: 'Możliwa różnica, nie potwierdzony fakt.',
        qualifiers: ['niepewna interpretacja'],
      },
    ],
    source_issues: [],
  };
  if (selected) {
    const names: Record<string, string> = {
      summary_pl: 'summary',
      entity_mentions: 'entities',
    };
    for (const key of Object.keys(wire))
      if (
        key !== 'source_issues' &&
        key !== 'entity_mentions' &&
        !selected.includes(names[key] ?? key)
      )
        delete wire[key];
    if (!selected.some((key) => !['summary', 'key_points'].includes(key)))
      wire.entity_mentions = [];
  }
  const { canonical } = await enrichSemantic(
    {
      raw: JSON.stringify(wire),
      completion: 'OK',
      run_id: 'run',
      item_id: 'a',
      profile_id: 'semantic-fixture',
      profile_revision: 'pinned',
      approved_aliases: [],
      source: {
        owner_id: 'owner',
        source_artifact_id: 'source',
        source_text: source.source_text,
        manifest: source.manifest,
        manifest_hash: source.manifest_hash,
        video_url: 'https://www.youtube.com/watch?v=abcdefghijk',
      },
    },
    profile,
  );
  const base: DailyItemView = {
    item_id: 'a',
    source_id: 'channel',
    title: 'Tytuł',
    creator: 'Twórca',
    canonical_url: 'https://www.youtube.com/watch?v=abcdefghijk',
    published_at: '2026-10-07T09:00:00Z',
    publication_provenance: 'SOURCE',
    duration_seconds: null,
    metadata_revision: 'metadata',
    selected_run_id: 'run',
    selection_revision: 1,
    analysis_status: 'READY',
    reason: null,
    retry_at: null,
    processing_state: 'DONE',
    view: null,
  };
  const items = [
    base,
    ...(['PENDING', 'BLOCKED', 'FAILED'] as const).map(
      (analysis_status, index) => ({
        ...base,
        item_id: `pending-${index}`,
        selected_run_id: null,
        selection_revision: null,
        analysis_status,
        reason: 'LOCAL_EXECUTOR_OFFLINE',
        retry_at: null,
      }),
    ),
  ];
  const input: DailyRenderInput = {
    snapshot: {
      date: '2026-10-07',
      timezone: 'Europe/Warsaw',
      cut_seq: 12,
      projection_revision: 'snapshot',
      counts: { items: 4, ready: 1, pending: 3, blocked: 1, failed: 1 },
      discovery_complete: false,
      complete: false,
      partial: true,
      items,
      next_cursor: null,
      source_coverage: [],
      freshness: { sampled_at: '2026-10-07T10:00:00Z', status: 'CURRENT' },
    },
    selections: [
      {
        item_id: 'a',
        run_id: 'run',
        canonical_hash: hash(JSON.stringify(canonical)),
        canonical,
      },
    ],
    app_origin: 'https://bartosz-intelligence.eagleblastmusic.workers.dev',
    revision: 1,
  };
  return input;
}

// Independent reader uses wire delimiters and Node SHA, not renderer helpers.
function readReport(markdown: string) {
  const end = markdown.indexOf('\n---\n\n', 4);
  const header = Object.fromEntries(
    markdown
      .slice(4, end)
      .split('\n')
      .map((line) => {
        const at = line.indexOf(': ');
        return [line.slice(0, at), line.slice(at + 2)];
      }),
  );
  const footerAt = markdown.lastIndexOf('\nEND_REPORT ');
  const body = markdown.slice(end + 6, footerAt + 1);
  return {
    header,
    body,
    ids: [...body.matchAll(/^ITEM ([A-Za-z0-9_-]+)$/gm)].map(
      (match) => match[1],
    ),
    footer: markdown.slice(footerAt + 1),
  };
}
it('renders deterministic whole-day bytes with independent body hash, counts and UTF-8 estimates; freshness is not content', async () => {
  const input = await fixture();
  const report = await renderDaily(input),
    decoded = readReport(report.markdown);
  expect(decoded.ids).toEqual(['pending-2', 'pending-1', 'pending-0', 'a']);
  expect(decoded.header.body_sha256).toBe(hash(decoded.body));
  expect(report.content_hash).toBe(hash(report.markdown));
  expect(report.byte_count).toBe(Buffer.byteLength(report.markdown));
  expect(report.estimated_tokens).toBe(Math.ceil(report.byte_count / 3));
  expect(decoded.footer).toBe(
    'END_REPORT date=2026-10-07 revision=1 item_count=4 ready_count=1 pending_count=3\n',
  );
  expect(report.partial).toBe(true);
  expect(report.markdown).toContain('Następna próba: null');
  expect(report.markdown).not.toContain('Druga pełna notatka');
  input.snapshot.items.reverse();
  input.snapshot.freshness.sampled_at = '2026-10-08T00:00:00Z';
  expect(await renderDaily(input)).toEqual(report);
});
it('rejects partial pages, foreign day/undated items, changed canonical, wrong selection and incorrect pending denominator', async () => {
  const original = await fixture();
  for (const mutate of [
    (i: DailyRenderInput) => {
      i.snapshot.next_cursor = 'next';
    },
    (i: DailyRenderInput) => {
      i.snapshot.items.pop();
    },
    (i: DailyRenderInput) => {
      i.snapshot.items[0]!.published_at = null;
    },
    (i: DailyRenderInput) => {
      i.snapshot.items[0]!.published_at = '2026-10-06T20:00:00Z';
    },
    (i: DailyRenderInput) => {
      i.selections[0]!.canonical.claims[0]!.content_pl = 'Changed';
    },
    (i: DailyRenderInput) => {
      i.selections[0]!.run_id = 'foreign';
    },
    (i: DailyRenderInput) => {
      i.snapshot.counts.pending = 1;
    },
  ]) {
    const input = structuredClone(original);
    mutate(input);
    await expect(renderDaily(input)).rejects.toThrow();
  }
});
it('preserves Custom fallback negation, attribution, quantity and all qualifiers as an indivisible minimum under OVERSIZE', async () => {
  const input = await fixture(['claims']);
  input.compact_token_budget = 1;
  const report = await renderDaily(input);
  expect(report.compaction_level).toBe(3);
  expect(report.bridge_size_state).toBe('OVERSIZE');
  expect(report.item_ids).toHaveLength(4);
  expect(report.markdown).toContain(
    'Autor nie wdrożył Tool X; tylko 20% pod warunkiem testu.',
  );
  expect(report.markdown).toContain(
    'Warunek / zastrzeżenie: pod warunkiem testu',
  );
  expect(report.markdown).toContain('SOURCE\\_SPEAKER');
  expect(report.markdown).toContain('Podsumowanie: poza zakresem profilu.');
  expect(report.markdown).toContain(
    'Najważniejsze punkty: poza zakresem profilu.',
  );
});
it('FULL preserves contradiction interpretation, both complete sides, Evidence null time and selected units without another model', async () => {
  const input = await fixture();
  input.mode = 'FULL';
  const report = await renderDaily(input);
  expect(report.markdown).toContain('Interpretacja analizy (SOURCE_INFERENCE)');
  expect(report.markdown).toContain('Autor przytacza opinię innej osoby.');
  expect(report.markdown).toContain('REPORTED\\_OTHER');
  expect(report.markdown).toContain('niepewna interpretacja');
  expect(report.markdown).toContain('Druga pełna notatka.');
  expect(report.markdown).toContain('### Evidence');
  expect(report.markdown).toContain('null');
  expect(report.omitted_detail_units).toBe(0);
});
it('retains tools-only Custom context and distinguishes legitimately empty selected arrays', async () => {
  const input = await fixture(['tools']);
  input.compact_token_budget = 1;
  expect((await renderDaily(input)).markdown).toContain(
    'Tylko wypróbowane, nie wdrożone.',
  );
  const empty = await fixture(['summary']);
  empty.selections[0]!.canonical.summary_pl = [];
  empty.selections[0]!.canonical_hash = hash(
    JSON.stringify(empty.selections[0]!.canonical),
  );
  expect((await renderDaily(empty)).markdown).toContain(
    'W wybranym zakresie nie znaleziono treści',
  );
});
it('escapes injected protocol markers, HTML and Markdown links without losing Items', async () => {
  const input = await fixture();
  input.snapshot.items[0]!.title =
    'evil\nITEM fake\nEND_REPORT date=fake\n---\n<img src=x> [x](javascript:evil)';
  const report = await renderDaily(input),
    decoded = readReport(report.markdown);
  expect(decoded.ids).toHaveLength(4);
  expect(decoded.ids).not.toContain('fake');
  expect(report.markdown).not.toContain('<img');
  expect(report.markdown).toContain('&lt;img');
  input.snapshot.items[0]!.canonical_url = 'javascript:evil';
  await expect(renderDaily(input)).rejects.toThrow('INVALID_EXPORT_LINK');
});
it('compacts a large corpus atomically, keeping one summary and one point and every pending Item', async () => {
  const input = await fixture();
  const original = input.snapshot.items[1]!;
  for (let n = 0; n < 500; n++)
    input.snapshot.items.push({
      ...original,
      item_id: `extra-${n}`,
      title: 'Duży korpus 🧠'.repeat(10),
    });
  input.snapshot.counts.items += 500;
  input.snapshot.counts.pending += 500;
  input.compact_token_budget = 16000;
  const report = await renderDaily(input);
  expect(report.item_ids).toHaveLength(504);
  expect(report.bridge_size_state).toBe('OVERSIZE');
  expect(readReport(report.markdown).ids).toHaveLength(504);
  expect(report.markdown).toContain('Żółć 🧠 — nie wdrożył.');
  expect(report.markdown).toContain('Pełny punkt 1 z negacją: nie.');
  expect(report.markdown).not.toContain('Pełny punkt 2');
});
