import { it, expect } from 'vitest';
import {
  dailyFolderNames,
  previousMaterialDate,
  closedDay,
  manifestHash,
  parseDailyReport,
  renderDailyReport,
} from '../../packages/core/src/daily/format.js';
import { localDayRange } from '../../packages/core/src/projections/dates.js';
import type {
  DailyManifest,
  DailyReport,
} from '../../packages/contracts/src/daily-report.js';
const manifest: DailyManifest = {
  schema: 'bi-daily-manifest:1',
  material_date: '2026-10-11',
  timezone: 'Europe/Warsaw',
  closed_at: '2026-10-11T22:00:00.000Z',
  expected_count: 2,
  ready_count: 2,
  entries: ['rUhllpnYWR8', 'abcdefghijk'].map((video_id) => ({
    video_id,
    title: 'Film ' + video_id,
    youtube_url: 'https://www.youtube.com/watch?v=' + video_id,
    transcript_file_id: 'drive_' + video_id,
    transcript_sha256: 'a'.repeat(64),
    source_sha256: 'b'.repeat(64),
    acquired_at: '2026-10-11T18:00:00.000Z',
    state: 'READY',
  })),
};
export async function exampleReport(
  input: DailyManifest = manifest,
): Promise<DailyReport> {
  return {
    schema: 'bi-daily-report:1',
    material_date: input.material_date,
    generated_at: '2026-10-12T08:00:00+02:00',
    timezone: 'Europe/Warsaw',
    manifest_sha256: await manifestHash(input),
    expected_count: input.entries.length,
    processed_count: input.entries.length,
    skipped_count: 0,
    videos: input.entries.map((e) => ({
      video_id: e.video_id,
      title: e.title,
      category: e.video_id === 'rUhllpnYWR8' ? 'Nauka' : 'AI i Robotyka',
      youtube_url: e.youtube_url,
      transcript_file_id: e.transcript_file_id,
      material_date: input.material_date,
      status: 'PROCESSED',
      reason: null,
      summary:
        'Autor opisuje konkretne wyniki doświadczenia i oddziela obserwacje od hipotez. '
          .repeat(12)
          .trim(),
    })),
  };
}
it('uses every Polish month and strict padded dates', () => {
  expect(
    Array.from(
      { length: 12 },
      (_, m) =>
        dailyFolderNames('2026-' + String(m + 1).padStart(2, '0') + '-09')[1],
    ),
  ).toEqual([
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
  ]);
  expect(dailyFolderNames('2026-10-09')).toEqual(['2026', 'Październik', '09']);
  expect(() => dailyFolderNames('2026-02-30')).toThrow();
});
it('closes precisely at Warsaw midnight, handles both DST changes and 08:00 previous calendar day', () => {
  expect(closedDay('2026-10-11', new Date('2026-10-11T21:59:59.999Z'))).toBe(
    false,
  );
  expect(closedDay('2026-10-11', new Date('2026-10-11T22:00:00.000Z'))).toBe(
    true,
  );
  expect(previousMaterialDate(new Date('2026-10-12T06:00:00Z'))).toBe(
    '2026-10-11',
  );
  for (const [date, hours] of [
    ['2026-03-29', 23],
    ['2026-10-25', 25],
  ] as const) {
    const range = localDayRange(date);
    expect((Date.parse(range.end) - Date.parse(range.start)) / 3600000).toBe(
      hours,
    );
    expect(previousMaterialDate(new Date(date + 'T07:00:00Z'))).toBe(
      date === '2026-03-29' ? '2026-03-28' : '2026-10-24',
    );
  }
});
it('roundtrips all sources, categories, counts and summaries in one readable report', async () => {
  const report = await exampleReport(),
    text = renderDailyReport(report);
  expect(
    await parseDailyReport(text, manifest, await manifestHash(manifest)),
  ).toEqual(report);
  expect(text.match(/# Bartosz Intelligence — Daily/g)).toHaveLength(1);
  expect(text).not.toContain('## Polityka');
  expect(text).not.toContain('## Pozostałe');
});
it('rejects omissions, duplicate films, wrong identity/category/hash/counts and placeholder summaries', async () => {
  for (const alter of [
    (r: DailyReport) => {
      r.videos.pop();
    },
    (r: DailyReport) => {
      r.videos[1] = structuredClone(r.videos[0]!);
    },
    (r: DailyReport) => {
      r.videos[0]!.category = 'Sport' as never;
    },
    (r: DailyReport) => {
      r.videos[0]!.transcript_file_id = 'other';
    },
    (r: DailyReport) => {
      r.videos[0]!.youtube_url = 'https://example.com/';
    },
    (r: DailyReport) => {
      r.processed_count = 0;
    },
    (r: DailyReport) => {
      r.manifest_sha256 = '0'.repeat(64);
    },
    (r: DailyReport) => {
      r.videos[0]!.summary = 'Jedno zdanie.';
    },
  ]) {
    const report = await exampleReport();
    alter(report);
    await expect(
      parseDailyReport(
        renderDailyReport(report),
        manifest,
        await manifestHash(manifest),
      ),
    ).rejects.toThrow('INVALID_DAILY_REPORT');
  }
});
it('allows explicit unprocessed entries, rejects processing a pending source, and does not lose the final summary sentence', async () => {
  const pending = structuredClone(manifest);
  pending.entries[1]!.state = 'PENDING';
  pending.entries[1]!.transcript_file_id = null;
  pending.entries[1]!.transcript_sha256 = null;
  pending.ready_count = 1;
  const report = await exampleReport(pending);
  await expect(
    parseDailyReport(
      renderDailyReport(report),
      pending,
      await manifestHash(pending),
    ),
  ).rejects.toThrow();
  Object.assign(report.videos[1]!, {
    status: 'UNPROCESSED',
    reason: 'Transkrypcja czeka na readback Drive',
    summary: '',
  });
  report.processed_count = 1;
  report.skipped_count = 1;
  report.videos[0]!.summary +=
    ' Na końcu autor podał ważne zastrzeżenie: wynik wymaga powtórzenia.';
  const parsed = await parseDailyReport(
    renderDailyReport(report),
    pending,
    await manifestHash(pending),
  );
  expect(parsed.videos[0]!.summary).toContain('wynik wymaga powtórzenia.');
  expect(parsed.skipped_count).toBe(1);
});
