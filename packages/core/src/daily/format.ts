import { sha256 } from '../auth/crypto.js';
import {
  publicationDate,
  requireLocalDate,
  localDayRange,
} from '../projections/dates.js';
import { requireDriveId } from '../drive/client.js';
import {
  dailyCategories,
  type DailyManifest,
  type DailyReport,
  type DailyReportVideo,
} from '../../../contracts/src/daily-report.js';

export const polishMonths = [
  'Styczeń',
  'Luty',
  'Marzec',
  'Kwiecień',
  'Maj',
  'Czerwiec',
  'Lipiec',
  'Sierpień',
  'Wrzesień',
  'Październik',
  'Listopad',
  'Grudzień',
] as const;
export function dailyFolderNames(date: string) {
  requireLocalDate(date);
  return [
    date.slice(0, 4),
    polishMonths[Number(date.slice(5, 7)) - 1]!,
    date.slice(8, 10),
  ];
}
export function previousMaterialDate(now: Date) {
  const date = publicationDate(now.toISOString());
  return new Date(requireLocalDate(date) - 86400000).toISOString().slice(0, 10);
}
export function closedDay(date: string, now: Date) {
  return now.toISOString() >= localDayRange(date).end;
}
const invalid = () => new Error('INVALID_DAILY_REPORT');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid();
  return value as Record<string, unknown>;
}
function keys(row: Record<string, unknown>, expected: string[]) {
  if (Object.keys(row).sort().join(',') !== expected.sort().join(','))
    throw invalid();
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 2000)
    throw invalid();
  return Number(value);
}
export function manifestText(manifest: DailyManifest, digest: string) {
  if (!/^[a-f0-9]{64}$/.test(digest))
    throw new Error('INVALID_DAILY_MANIFEST_HASH');
  return (
    '# Bartosz Intelligence — manifest dzienny\n\n[BI_MANIFEST]\n' +
    JSON.stringify(manifest, null, 2) +
    '\n[/BI_MANIFEST]\n\nManifest SHA-256 (kanoniczny JSON): ' +
    digest +
    '\n'
  );
}
export async function manifestHash(manifest: DailyManifest) {
  return sha256(JSON.stringify(manifest));
}
/** Visible text markers survive a native Docs text/plain export. Source text is
 * never executed, rendered as HTML, or interpreted as instructions. */
export async function parseDailyReport(
  text: string,
  manifest: DailyManifest,
  expectedHash: string,
): Promise<DailyReport> {
  if (
    new TextEncoder().encode(text).length > 1048576 ||
    !text.trim() ||
    (await manifestHash(manifest)) !== expectedHash
  )
    throw invalid();
  const headers = [
    ...text.matchAll(/\[BI_REPORT\]\s*([\s\S]*?)\s*\[\/BI_REPORT\]/g),
  ];
  if (headers.length !== 1) throw invalid();
  let meta: Record<string, unknown>;
  try {
    meta = object(JSON.parse(headers[0]![1]!));
  } catch {
    throw invalid();
  }
  keys(meta, [
    'schema',
    'material_date',
    'generated_at',
    'timezone',
    'manifest_sha256',
    'expected_count',
    'processed_count',
    'skipped_count',
  ]);
  if (
    meta.schema !== 'bi-daily-report:1' ||
    meta.material_date !== manifest.material_date ||
    meta.timezone !== 'Europe/Warsaw' ||
    meta.manifest_sha256 !== expectedHash ||
    typeof meta.generated_at !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?(?:Z|[+-]\d\d:\d\d)$/.test(
      meta.generated_at,
    ) ||
    !Number.isFinite(Date.parse(meta.generated_at)) ||
    Date.parse(meta.generated_at) < Date.parse(manifest.closed_at)
  )
    throw invalid();
  const blocks = [
    ...text.matchAll(
      /\[BI_VIDEO\]\s*([\s\S]*?)\s*\[BI_TEXT\]\n?([\s\S]*?)\n?\[\/BI_TEXT\]\s*\[\/BI_VIDEO\]/g,
    ),
  ];
  if (
    blocks.length !== manifest.entries.length ||
    (text.match(/\[BI_VIDEO\]/g) ?? []).length !== blocks.length ||
    (text.match(/\[BI_TEXT\]/g) ?? []).length !== blocks.length
  )
    throw invalid();
  const seen = new Set<string>(),
    videos: DailyReportVideo[] = [];
  for (const block of blocks) {
    let row: Record<string, unknown>;
    try {
      row = object(JSON.parse(block[1]!));
    } catch {
      throw invalid();
    }
    keys(row, [
      'video_id',
      'title',
      'category',
      'youtube_url',
      'transcript_file_id',
      'material_date',
      'status',
      'reason',
    ]);
    const entry = manifest.entries.find((e) => e.video_id === row.video_id),
      summary = block[2]!.trim();
    if (
      !entry ||
      seen.has(entry.video_id) ||
      !/^[A-Za-z0-9_-]{11}$/.test(entry.video_id) ||
      row.title !== entry.title ||
      row.youtube_url !== entry.youtube_url ||
      row.transcript_file_id !== entry.transcript_file_id ||
      row.material_date !== manifest.material_date ||
      !dailyCategories.includes(row.category as never) ||
      !['PROCESSED', 'UNPROCESSED'].includes(String(row.status)) ||
      /\[\/?BI_[A-Z_]+\]/.test(summary)
    )
      throw invalid();
    if (row.transcript_file_id !== null)
      requireDriveId(String(row.transcript_file_id));
    if (row.status === 'PROCESSED') {
      // No rigid word cap. Reject empty/one-line placeholders and invented readiness.
      if (
        entry.state !== 'READY' ||
        !entry.transcript_file_id ||
        !entry.transcript_sha256 ||
        row.reason !== null ||
        summary.split(/\s+/u).length < 40
      )
        throw invalid();
    } else if (
      summary ||
      typeof row.reason !== 'string' ||
      !row.reason.trim() ||
      row.reason.length > 1000
    )
      throw invalid();
    seen.add(entry.video_id);
    videos.push({ ...row, summary } as unknown as DailyReportVideo);
  }
  const processed = videos.filter((v) => v.status === 'PROCESSED').length,
    skipped = videos.length - processed;
  if (
    count(meta.expected_count) !== manifest.expected_count ||
    count(meta.processed_count) !== processed ||
    count(meta.skipped_count) !== skipped ||
    processed + skipped !== manifest.expected_count
  )
    throw invalid();
  return { ...meta, videos } as unknown as DailyReport;
}
export function renderDailyReport(report: DailyReport) {
  const { videos, ...metadata } = report;
  const parts = [
    '# Bartosz Intelligence — Daily',
    `Data materiałów: ${report.material_date}`,
    `Wygenerowano: ${publicationDate(report.generated_at)}`,
    '[BI_REPORT]\n' + JSON.stringify(metadata, null, 2) + '\n[/BI_REPORT]',
  ];
  for (const category of dailyCategories) {
    const members = videos.filter((v) => v.category === category);
    if (!members.length) continue;
    parts.push('## ' + category);
    for (const video of members) {
      const { summary, ...meta } = video;
      parts.push(
        '### ' + video.title,
        'Film: ' + video.youtube_url,
        'ID filmu: ' + video.video_id,
        'Transkrypcja: ' +
          (video.transcript_file_id
            ? 'https://drive.google.com/file/d/' +
              video.transcript_file_id +
              '/view'
            : 'jeszcze niedostępna'),
        '[BI_VIDEO]\n' +
          JSON.stringify(meta, null, 2) +
          '\n[BI_TEXT]\n' +
          summary +
          '\n[/BI_TEXT]\n[/BI_VIDEO]',
      );
      if (video.reason) parts.push('Nieprzetworzono: ' + video.reason);
    }
  }
  return parts.join('\n\n') + '\n';
}
