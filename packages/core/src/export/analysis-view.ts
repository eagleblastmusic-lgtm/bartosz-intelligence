import type { enrichEconomy } from '../ai/enrichment/canonical.js';
import { validateCanonical } from '../ai/repair/validate.js';

export type AnalysisCanonical = Awaited<
  ReturnType<typeof enrichEconomy>
>['canonical'];
export function analysisText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    /^(?:undefined|null|NaN|\[object Object\])$/u.test(value.trim())
  )
    throw new Error('BROKEN_ANALYSIS_CONTENT');
  return value;
}
export function canonicalCitations(
  c: AnalysisCanonical,
  ids: readonly string[],
  videoUrl?: string,
) {
  if (!ids.length) throw new Error('EXPORT_EVIDENCE_MISSING');
  return ids.map((id) => {
    const e = c.evidence.find((row) => row.evidence_id === id);
    if (!e || e.source_artifact_id !== c.source_artifact_id)
      throw new Error('EXPORT_EVIDENCE_MISSING');
    if (!e.timestamp_url) return { label: 'czas nieustalony', url: null };
    const url = new URL(e.timestamp_url);
    if (
      url.origin !== 'https://www.youtube.com' ||
      url.pathname !== '/watch' ||
      !/^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get('v') ?? '') ||
      (videoUrl &&
        url.searchParams.get('v') !==
          new URL(videoUrl).searchParams.get('v')) ||
      e.start_ms === null ||
      url.searchParams.get('t') !== `${Math.floor(e.start_ms / 1000)}s`
    )
      throw new Error('EXPORT_EVIDENCE_LOCATOR_MISMATCH');
    return {
      label: `${Math.floor(e.start_ms / 60000)}:${String(Math.floor(e.start_ms / 1000) % 60).padStart(2, '0')}`,
      url: url.href,
    };
  });
}
function escape(value: string) {
  return analysisText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\\', '\\\\')
    .replace(/[\r\n\u2028\u2029]/g, ' ')
    .replace(/([`*_{}\[\]()#!|])/g, '\\$1');
}
export function renderAnalysisReview(c: AnalysisCanonical, videoUrl: string) {
  if (!validateCanonical(c)) throw new Error('EXPORT_CANONICAL_MISMATCH');
  const cite = (ids: readonly string[]) =>
    canonicalCitations(c, ids, videoUrl)
      .map((ref) => (ref.url ? `[${ref.label}](${ref.url})` : ref.label))
      .join(', ');
  const lines: string[] = [];
  for (const [title, rows] of [
    ['Streszczenie', c.summary_pl],
    ['Najważniejsze ustalenia', c.key_points],
  ] as const) {
    lines.push(`## ${title}`, '');
    for (const row of rows)
      lines.push(
        `- ${escape(row.text_pl)}`,
        '  Atrybucja: relacja z wypowiedzi rozmówców, bez niezależnej weryfikacji faktów.',
        `  Źródło: ${cite(row.evidence_ids)}.`,
        '',
      );
  }
  for (const [title, rows] of [
    ['Szczegółowe twierdzenia', c.claims],
    ['Prognozy', c.predictions],
  ] as const) {
    lines.push(`## ${title}`, '');
    for (const row of rows) {
      const subject = row.subject_ref
        ? c.entities.find((e) => e.entity_id === row.subject_ref)?.label
        : null;
      if (row.subject_ref && !subject) throw new Error('EXPORT_ENTITY_MISSING');
      lines.push(
        `- ${escape(row.content_pl)}`,
        `  Atrybucja: ${escape(subject ?? 'rozmówca nieustalony')}; ${escape(row.attribution)}; ${escape(row.epistemic_status)}.`,
        ...row.qualifiers.map((q) => `  Zastrzeżenie: ${escape(q)}`),
        `  Źródło: ${cite(row.evidence_ids)}.`,
        '',
      );
    }
  }
  return lines.join('\n');
}
