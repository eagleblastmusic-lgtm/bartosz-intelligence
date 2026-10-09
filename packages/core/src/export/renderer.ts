import type {
  DailyItemView,
  DailySnapshot,
} from '../../../contracts/src/daily.js';
import type { enrichEconomy } from '../ai/enrichment/canonical.js';
import { validateCanonical } from '../ai/repair/validate.js';
import { sha256 } from '../auth/crypto.js';
import {
  publicationDate,
  publicationTimestamp,
  requireLocalDate,
} from '../projections/dates.js';

type Canonical = Awaited<ReturnType<typeof enrichEconomy>>['canonical'];
type TypedUnit = Canonical['claims'][number];
const typedModules = [
  'claims',
  'stance',
  'predictions',
  'usage',
  'recommendations',
  'uncertainties',
  'contradictions',
] as const;
export type ExportMode = 'COMPACT' | 'FULL';
export interface ExportSelection {
  item_id: string;
  run_id: string;
  canonical_hash: string;
  canonical: Canonical;
}
export interface DailyRenderInput {
  archived_blocks?: Record<string, string>;
  snapshot: DailySnapshot;
  selections: readonly ExportSelection[];
  app_origin: string;
  revision: number;
  mode?: ExportMode;
  compact_token_budget?: number;
}
export interface DailyReport {
  schema_version: '1.1';
  renderer_version: 'daily-renderer:1.1';
  date: string;
  revision: number;
  source_change_seq: number;
  export_mode: ExportMode;
  markdown: string;
  body_sha256: string;
  content_hash: string;
  byte_count: number;
  estimated_tokens: number;
  estimator_version: 'utf8-ceil-div3:1';
  estimator_notice: string;
  compaction_level: number;
  bridge_size_state: 'WITHIN_ESTIMATE' | 'OVERSIZE';
  omitted_detail_units: number;
  partial: boolean;
  item_ids: string[];
  archive_members?: {
    item_id: string;
    run_id: string;
    canonical_hash: string;
  }[];
}

// Every untrusted field occupies one escaped Markdown line. This also prevents
// source content from forging frontmatter, ITEM markers or END_REPORT records.
function text(value: string) {
  return value
    .replaceAll('\\', '\\\\')
    .replace(/[\r\n\u2028\u2029]/g, (c) => (c === '\r' ? '\\r' : '\\n'))
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
    .replace(/([`*_{}\[\]()#!|])/g, '\\$1');
}
function link(label: string, locator: string) {
  const url = new URL(locator);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('INVALID_EXPORT_LINK');
  return `[${text(label)}](${url.href.replace(/[()]/g, (c) =>
    c === '(' ? '%28' : '%29',
  )})`;
}
function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function metric(value: string) {
  const bytes = new TextEncoder().encode(value).length;
  return { bytes, tokens: Math.ceil(bytes / 3) };
}
function allUnits(c: Canonical) {
  return typedModules.flatMap((key) => c[key]);
}
function evidenceRefs(c: Canonical, ids: readonly string[]) {
  if (ids.some((id) => !c.evidence.some((e) => e.evidence_id === id)))
    throw new Error('EXPORT_EVIDENCE_MISSING');
  return `Evidence refs: ${ids.map(text).join('; ') || 'brak'}`;
}
function renderTyped(
  unit: TypedUnit,
  c: Canonical,
  appItem: string,
  stack = new Set<string>(),
): string[] {
  if (stack.has(unit.observation_id)) throw new Error('EXPORT_RELATION_CYCLE');
  const lines = [
    `- ${text(unit.kind)}: ${text(unit.content_pl)}`,
    `  Atrybucja: ${text(unit.attribution)}; status epistemiczny: ${text(unit.epistemic_status)}.`,
    `  Observation: ${text(unit.observation_id)}; ${evidenceRefs(c, unit.evidence_ids)}`,
  ];
  for (const key of [
    'subject_ref',
    'target_ref',
    'temporal_text',
    'stance_polarity',
    'usage_stage',
    'prediction_horizon',
  ] as const)
    if (unit[key] !== null) lines.push(`  ${key}: ${text(unit[key]!)}`);
  for (const qualifier of unit.qualifiers)
    lines.push(`  Warunek / zastrzeżenie: ${text(qualifier)}`);
  for (const ref of unit.entity_refs) {
    const entity = c.entities.find((e) => e.entity_id === ref);
    if (!entity) throw new Error('EXPORT_ENTITY_MISSING');
    lines.push(`  Podmiot: ${text(entity.label)} (${text(ref)})`);
  }
  lines.push(
    `  ${link('Jednostka w aplikacji', appItem + '#observation-' + encodeURIComponent(unit.observation_id))}`,
  );
  if (unit.epistemic_status === 'SOURCE_INFERENCE')
    lines.push(
      '  Interpretacja analizy (SOURCE_INFERENCE), nie dosłowna wypowiedź autora.',
    );
  for (const ref of unit.relation_refs) {
    const side = allUnits(c).find((row) => row.observation_id === ref);
    if (!side) throw new Error('EXPORT_RELATION_SIDE_MISSING');
    lines.push(
      '  Strona relacji:',
      ...renderTyped(
        side,
        c,
        appItem,
        new Set([...stack, unit.observation_id]),
      ).map((line) => '  ' + line),
    );
  }
  return lines;
}
function labels(c: Canonical) {
  const rows = [
    ...(c.enabled_modules.includes('entities')
      ? c.entities.map((e) => e.label)
      : []),
    ...(c.enabled_modules.includes('tools')
      ? c.tools.map((tool) => {
          const entity = c.entities.find(
            (e) => e.entity_id === tool.entity_ref,
          );
          if (!entity) throw new Error('EXPORT_ENTITY_MISSING');
          return entity.label;
        })
      : []),
  ];
  return [...new Set(rows)];
}
function block(
  item: DailyItemView,
  c: Canonical | undefined,
  origin: string,
  mode: ExportMode,
  level: number,
) {
  const appItem = origin + '/items/' + encodeURIComponent(item.item_id);
  const lines = [
    `ITEM ${item.item_id}`,
    `## ${text(item.title)}`,
    `Twórca: ${text(item.creator)}`,
    item.published_at
      ? `Publikacja: ${publicationTimestamp(item.published_at)}; źródłowy timestamp: ${text(item.published_at)}`
      : 'Publikacja: nieustalona; dzień raportu wynika z daty wykrycia, nie daty publikacji.',
    `Czas trwania (sekundy): ${item.duration_seconds ?? 'null'}`,
    `Status: ${text(item.analysis_status)}`,
    link('Źródło', item.canonical_url) +
      ' · ' +
      link('Materiał w aplikacji', appItem),
  ];
  let omitted = 0;
  if (!c) {
    lines.push(
      'Profil: nieustalony (brak wybranego zaakceptowanego wyniku).',
      `Przyczyna: ${item.reason === null ? 'null' : text(item.reason)}`,
      `Następna próba: ${item.retry_at === null ? 'null' : text(item.retry_at)}`,
      'Brak kompletnej analizy; bez wygenerowanego podsumowania.',
    );
    return { lines, omitted };
  }
  lines.push(
    `Profil: ${text(c.profile_id)}; revision=${text(c.profile_revision)}`,
    `Zakres: ${c.enabled_modules.map(text).join(', ') || 'pusty'}`,
  );
  if (item.analysis_status !== 'READY')
    lines.push(
      `Analiza częściowa; przyczyna: ${item.reason === null ? 'null' : text(item.reason)}; następna próba: ${item.retry_at === null ? 'null' : text(item.retry_at)}.`,
    );
  if (c.source_issues.length)
    lines.push(`Problemy źródła: ${c.source_issues.map(text).join('; ')}`);
  const summaries = c.enabled_modules.includes('summary') ? c.summary_pl : [];
  const points = c.enabled_modules.includes('key_points') ? c.key_points : [];
  if (!c.enabled_modules.includes('summary'))
    lines.push('Podsumowanie: poza zakresem profilu.');
  if (!c.enabled_modules.includes('key_points'))
    lines.push('Najważniejsze punkty: poza zakresem profilu.');
  const keptSummary = mode === 'FULL' ? summaries : summaries.slice(0, 1);
  const keptPoints =
    mode === 'FULL' ? points : points.slice(0, Math.max(1, 3 - level));
  for (const row of keptSummary) {
    lines.push(`Podsumowanie: ${text(row.text_pl)}`);
    if (mode === 'FULL') lines.push(`  ${evidenceRefs(c, row.evidence_ids)}`);
  }
  for (const row of keptPoints) {
    lines.push(`- Punkt: ${text(row.text_pl)}`);
    if (mode === 'FULL') lines.push(`  ${evidenceRefs(c, row.evidence_ids)}`);
  }
  omitted +=
    summaries.length - keptSummary.length + points.length - keptPoints.length;
  const selectedTyped = typedModules.filter((key) =>
    c.enabled_modules.includes(key),
  );
  const units = selectedTyped.flatMap((key) => c[key]);
  if (mode === 'FULL') {
    for (const unit of units) lines.push(...renderTyped(unit, c, appItem));
  } else if (!summaries.length && !points.length && units.length) {
    lines.push(
      'Pełna jednostka wybranego zakresu (nie zastępuje podsumowania):',
      ...renderTyped(units[0]!, c, appItem),
    );
    omitted += units.length - 1;
  } else omitted += units.length;
  const entityLabels = labels(c);
  // Tools-only Custom context is an atomic minimum, not an optional label addon.
  const toolsOnly = !summaries.length && !points.length && !units.length;
  const keptLabels =
    mode === 'FULL' || toolsOnly
      ? entityLabels
      : entityLabels.slice(0, level >= 3 ? 0 : 6);
  if (keptLabels.length)
    lines.push(`Podmioty / narzędzia: ${keptLabels.map(text).join('; ')}`);
  omitted += entityLabels.length - keptLabels.length;
  if (c.enabled_modules.includes('tools') && (mode === 'FULL' || toolsOnly))
    for (const tool of c.tools) {
      const entity = c.entities.find((e) => e.entity_id === tool.entity_ref);
      if (!entity) throw new Error('EXPORT_ENTITY_MISSING');
      lines.push(
        `Kontekst narzędzia: ${text(tool.context_pl)}`,
        `  Narzędzie: ${text(entity.label)} (${text(tool.entity_ref)}); ${evidenceRefs(c, tool.evidence_ids)}`,
      );
    }
  if (mode === 'FULL' && c.enabled_modules.includes('entities'))
    for (const entity of c.entities)
      lines.push(
        `Podmiot: ${text(entity.label)} (${text(entity.entity_id)}); ${evidenceRefs(c, entity.evidence_ids)}`,
      );
  if (
    !summaries.length &&
    !points.length &&
    !units.length &&
    !entityLabels.length &&
    !c.tools.length
  )
    lines.push('W wybranym zakresie nie znaleziono treści tych rodzajów.');
  if (mode === 'FULL') {
    lines.push('### Evidence');
    for (const evidence of c.evidence) {
      lines.push(`- Evidence: ${text(evidence.evidence_id)}`);
      // Preserve the entire canonical Evidence record, including null timestamps.
      lines.push(`  ${text(JSON.stringify(evidence))}`);
    }
  } else
    lines.push(
      `Kompaktowa projekcja; pełny wynik w aplikacji. Pominięte jednostki szczegółów: ${omitted}.`,
    );
  return { lines, omitted };
}

export async function renderDaily(
  input: DailyRenderInput,
): Promise<DailyReport> {
  // Snapshot is privately frozen before asynchronous hashing; a caller cannot
  // change the day, selected result or qualifiers while rendering proceeds.
  const frozen = structuredClone(input),
    { snapshot } = frozen;
  if (snapshot.date === null) throw new Error('DATED_EXPORT_REQUIRED');
  requireLocalDate(snapshot.date);
  const origin = new URL(frozen.app_origin);
  const mode = frozen.mode ?? 'COMPACT',
    budget = frozen.compact_token_budget ?? 16000;
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== frozen.app_origin ||
    !['COMPACT', 'FULL'].includes(mode) ||
    !Number.isSafeInteger(budget) ||
    budget < 1 ||
    !Number.isSafeInteger(frozen.revision) ||
    frozen.revision < 1 ||
    !Number.isSafeInteger(snapshot.cut_seq) ||
    snapshot.cut_seq < 0 ||
    snapshot.timezone !== 'Europe/Warsaw' ||
    snapshot.next_cursor !== null ||
    snapshot.items.length !== snapshot.counts.items
  )
    throw new Error('WHOLE_DAY_EXPORT_REQUIRED');
  const ids = new Set<string>(),
    selected = new Map<string, Canonical>();
  for (const selection of frozen.selections) {
    if (
      selected.has(selection.item_id) ||
      !validateCanonical(selection.canonical) ||
      selection.canonical.item_id !== selection.item_id ||
      (await sha256(JSON.stringify(selection.canonical))) !==
        selection.canonical_hash
    )
      throw new Error('EXPORT_CANONICAL_MISMATCH');
    const item = snapshot.items.find(
      (row) => row.item_id === selection.item_id,
    );
    if (!item || item.selected_run_id !== selection.run_id)
      throw new Error('EXPORT_SELECTION_MISMATCH');
    if (
      selection.canonical.source_issues.length &&
      item.analysis_status === 'READY'
    )
      throw new Error('EXPORT_READINESS_MISMATCH');
    selected.set(selection.item_id, selection.canonical);
  }
  for (const item of snapshot.items) {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(item.item_id) ||
      ids.has(item.item_id) ||
      !(item.published_at ?? item.discovered_at) ||
      (item.report_date ??
        publicationDate((item.published_at ?? item.discovered_at)!)) !==
        snapshot.date
    )
      throw new Error('EXPORT_DAY_ITEM_MISMATCH');
    ids.add(item.item_id);
    if (
      (item.selected_run_id !== null) !== selected.has(item.item_id) ||
      (item.analysis_status === 'READY' &&
        !selected.has(item.item_id) &&
        !item.archive)
    )
      throw new Error('EXPORT_SELECTION_MISSING');
    if (
      item.archive &&
      (mode !== 'FULL' || !frozen.archived_blocks?.[item.item_id])
    )
      throw new Error('ARCHIVED_REPORT_REQUIRES_RECOVERY');
  }
  const count = (state: string) =>
    snapshot.items.filter((i) => i.analysis_status === state).length;
  if (
    snapshot.counts.ready !== count('READY') ||
    snapshot.counts.pending !== snapshot.items.length - count('READY') ||
    snapshot.counts.blocked !== count('BLOCKED') ||
    snapshot.counts.failed !== count('FAILED')
  )
    throw new Error('EXPORT_COUNT_MISMATCH');
  const items = snapshot.items.toSorted(
    (a, b) =>
      compare(
        (b.published_at ?? b.discovered_at)!,
        (a.published_at ?? a.discovered_at)!,
      ) || compare(b.item_id, a.item_id),
  );
  const partial = snapshot.counts.pending > 0 || !snapshot.discovery_complete;
  for (let level = 0; level <= 3; level++) {
    const blocks = items.map((item) => {
      const archived = frozen.archived_blocks?.[item.item_id];
      if (item.archive && archived) {
        if (
          !archived.startsWith(`ITEM ${item.item_id}\n`) ||
          [...archived.matchAll(/^ITEM /gm)].length !== 1 ||
          [...archived.matchAll(/^Status: READY$/gm)].length !== 1
        )
          throw new Error('EXPORT_ARCHIVE_BLOCK_MISMATCH');
        return { lines: archived.replace(/\n+$/, '').split('\n'), omitted: 0 };
      }
      return block(
        item,
        selected.get(item.item_id),
        origin.origin,
        mode,
        level,
      );
    });
    const omitted = blocks.reduce((sum, row) => sum + row.omitted, 0);
    const body = [
      `# Bartosz Intelligence — ${snapshot.date}`,
      'Analizy wypowiedzi twórców, nie weryfikacja faktów. Twierdzenie ≠ fakt.',
      `Materiały: ${snapshot.counts.items}; gotowe: ${snapshot.counts.ready}; oczekujące: ${snapshot.counts.pending}; blocked: ${snapshot.counts.blocked}; failed: ${snapshot.counts.failed}.`,
      partial
        ? 'Raport częściowy: oczekujące analizy lub niepełne pokrycie odkrywania.'
        : 'Kompletne analizy i pokrycie odkrywania w tym snapshot.',
      ...blocks.flatMap((row) => ['', ...row.lines]),
      '',
    ].join('\n');
    const bodyHash = await sha256(body);
    const footer = `END_REPORT date=${snapshot.date} revision=${frozen.revision} item_count=${snapshot.counts.items} ready_count=${snapshot.counts.ready} pending_count=${snapshot.counts.pending}\n`;
    const assemble = (size: DailyReport['bridge_size_state']) =>
      [
        '---',
        'report_schema_version: "1.1"',
        `export_mode: ${mode}`,
        'renderer_version: "daily-renderer:1.1"',
        `date: ${snapshot.date}`,
        'timezone: Europe/Warsaw',
        `revision: ${frozen.revision}`,
        `source_change_seq: ${snapshot.cut_seq}`,
        `item_count: ${snapshot.counts.items}`,
        `ready_count: ${snapshot.counts.ready}`,
        `pending_count: ${snapshot.counts.pending}`,
        `blocked_count: ${snapshot.counts.blocked}`,
        `failed_count: ${snapshot.counts.failed}`,
        `discovery_coverage: ${snapshot.discovery_complete ? 'complete' : 'incomplete'}`,
        `compaction_level: ${level}`,
        `omitted_detail_units: ${omitted}`,
        `bridge_size_state: ${size}`,
        `body_sha256: ${bodyHash}`,
        '---',
        '',
      ].join('\n') +
      '\n' +
      body +
      footer;
    let size: DailyReport['bridge_size_state'] = 'WITHIN_ESTIMATE';
    let markdown = assemble(size);
    if (metric(markdown).tokens > budget) {
      if (mode === 'COMPACT' && level < 3) continue;
      size = 'OVERSIZE';
      markdown = assemble(size);
    }
    const measured = metric(markdown);
    return {
      schema_version: '1.1',
      renderer_version: 'daily-renderer:1.1',
      date: snapshot.date,
      revision: frozen.revision,
      source_change_seq: snapshot.cut_seq,
      export_mode: mode,
      markdown,
      body_sha256: bodyHash,
      content_hash: await sha256(markdown),
      byte_count: measured.bytes,
      estimated_tokens: measured.tokens,
      estimator_version: 'utf8-ceil-div3:1',
      estimator_notice:
        'Estymacja ceil(UTF-8 bytes / 3), bez zweryfikowanego tokenizer consumer; nie jest billing usage ani gwarancją limitu Bridge.',
      compaction_level: level,
      bridge_size_state: size,
      omitted_detail_units: omitted,
      partial,
      item_ids: items.map((item) => item.item_id),
      archive_members:
        mode === 'FULL' && omitted === 0
          ? frozen.selections
              .filter(
                (s) =>
                  s.canonical.status === 'OK' &&
                  s.canonical.source_issues.length === 0 &&
                  s.canonical.enabled_modules.includes('summary') &&
                  s.canonical.summary_pl.some((row) => row.text_pl.trim()),
              )
              .map((s) => ({
                item_id: s.item_id,
                run_id: s.run_id,
                canonical_hash: s.canonical_hash,
              }))
          : [],
    };
  }
  throw new Error('EXPORT_RENDER_FAILED');
}
