import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { DailyReportSnapshot } from '../../packages/contracts/src/daily-report.js';
const summary =
  'Autor wyjaśnia metodę badania, porównuje obserwacje z przewidywaniami i przywołuje konkretne liczby. Końcowe zastrzeżenie: potrzebne jest niezależne powtórzenie doświadczenia.';
function snapshot(
  date: string,
  state: DailyReportSnapshot['state'] = 'COMPLETE',
): DailyReportSnapshot {
  return {
    material_date: date,
    timezone: 'Europe/Warsaw',
    state,
    expected_count: 3,
    ready_count: 3,
    processed_count: state === 'MISSING' ? 0 : state === 'PARTIAL' ? 2 : 3,
    skipped_count: state === 'PARTIAL' ? 1 : 0,
    manifest_sha256: 'a'.repeat(64),
    manifest_file_id: 'manifest-fixture',
    report_file_id: state === 'MISSING' ? null : 'daily-fixture',
    verified_at: state === 'MISSING' ? null : '2026-10-12T06:10:00Z',
    missing_video_ids:
      state === 'MISSING'
        ? ['rUhllpnYWR8', 'abcdefghijk', 'ABCDEFGHIJK']
        : state === 'PARTIAL'
          ? ['ABCDEFGHIJK']
          : [],
    pending_video_ids: [],
    videos:
      state === 'MISSING'
        ? []
        : [
            ['rUhllpnYWR8', 'Nauka', 'Doświadczenie naukowe'],
            ['abcdefghijk', 'AI i Robotyka', 'Nowy robot'],
            ['ABCDEFGHIJK', 'Polityka', 'Opinia autora o wyborach'],
          ].map(([id, category, title]) => ({
            video_id: id!,
            title: title!,
            category: category as never,
            youtube_url: 'https://www.youtube.com/watch?v=' + id,
            transcript_file_id: 'transcript_' + id,
            material_date: date,
            status:
              state === 'PARTIAL' && id === 'ABCDEFGHIJK'
                ? 'UNPROCESSED'
                : 'PROCESSED',
            reason:
              state === 'PARTIAL' && id === 'ABCDEFGHIJK'
                ? 'Nie odczytano całej transkrypcji'
                : null,
            summary: state === 'PARTIAL' && id === 'ABCDEFGHIJK' ? '' : summary,
          })),
  };
}
async function setup(
  page: import('@playwright/test').Page,
  state: DailyReportSnapshot['state'] = 'COMPLETE',
) {
  const origin = 'https://daily-reports.fixture.invalid';
  await page.route(origin + '/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/session'))
      return route.fulfill({ json: { authenticated: true } });
    if (url.pathname.endsWith('/daily/reports/calendar'))
      return route.fulfill({
        json: {
          month: '2026-10',
          timezone: 'Europe/Warsaw',
          cut_seq: 1,
          projection_revision: '1',
          days: [
            {
              date: '2026-10-11',
              counts: { items: 3, ready: 3, pending: 0, blocked: 0, failed: 0 },
              discovery_complete: true,
              complete: state === 'COMPLETE',
            },
          ],
          freshness: { sampled_at: '2026-10-12T06:10:00Z', status: 'CURRENT' },
        },
      });
    if (url.pathname.startsWith('/api/v1/daily/reports/'))
      return route.fulfill({
        json: snapshot(url.pathname.split('/').at(-1)!, state),
      });
    if (url.pathname === '/api/v1/sources')
      return route.fulfill({ json: { sources: [], next_cursor: null } });
    if (url.pathname === '/api/v1/daily')
      return route.fulfill({
        json: {
          date: url.searchParams.get('date'),
          timezone: 'Europe/Warsaw',
          cut_seq: 1,
          projection_revision: '1',
          counts: { items: 0, ready: 0, pending: 0, blocked: 0, failed: 0 },
          discovery_complete: true,
          complete: true,
          partial: false,
          items: [],
          next_cursor: null,
          source_coverage: [],
          freshness: { sampled_at: '2026-10-12T06:10:00Z', status: 'CURRENT' },
        },
      });
    const response = await fetch('http://127.0.0.1:8787' + url.pathname);
    return route.fulfill({
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'text/plain',
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  return origin;
}
test('shows the complete daily report, filters the four-category contract, opens summaries and preserves source links', async ({
  page,
}) => {
  const origin = await setup(page);
  await page.goto(origin + '/daily/2026-10-11?view=reports');
  await expect(
    page.getByRole('heading', { name: 'Raport dzienny — 2026-10-11' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Raport kompletny' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Pozostałe', exact: true }),
  ).toHaveCount(0);
  await page.getByText('Doświadczenie naukowe', { exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Nauka', exact: true })
      .getByText(summary, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Oryginalny film YouTube' }).first(),
  ).toHaveAttribute('href', 'https://www.youtube.com/watch?v=rUhllpnYWR8');
  await expect(
    page.getByRole('link', { name: 'Pełna transkrypcja' }).first(),
  ).toHaveAttribute(
    'href',
    'https://drive.google.com/file/d/transcript_rUhllpnYWR8/view',
  );
  await page
    .getByRole('button', { name: 'AI i Robotyka', exact: true })
    .click();
  await expect(page.getByText('Nowy robot', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Doświadczenie naukowe', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Wszystkie', exact: true }).click();
  await page.screenshot({
    path: 'docs/verification/daily-workflow/gui-report-desktop.png',
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByRole('link', { name: 'Publikacje i dotychczasowe analizy' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Publikacje z 2026-10-11' }),
  ).toBeVisible();
});
test('keeps report dates in the existing navigator and explains missing or partial reports on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const origin = await setup(page, 'MISSING');
  await page.goto(origin + '/daily/2026-10-11?view=reports');
  await expect(
    page.getByRole('heading', { name: 'Brak raportu z ChatGPT' }),
  ).toBeVisible();
  await expect(
    page.getByText('Brak streszczeń: rUhllpnYWR8, abcdefghijk, ABCDEFGHIJK'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Poprzedni dzień' }).click();
  await expect(page).toHaveURL(/\/daily\/2026-10-10\?view=reports$/);
  await expect(
    page.getByRole('heading', { name: 'Raport dzienny — 2026-10-10' }),
  ).toBeVisible();
  await page.screenshot({
    path: 'docs/verification/daily-workflow/gui-report-mobile-missing.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test('shows a partial report with its exact unprocessed film and reason without inventing a summary', async ({
  page,
}) => {
  const origin = await setup(page, 'PARTIAL');
  await page.goto(origin + '/daily/2026-10-11?view=reports');
  await expect(
    page.getByRole('heading', { name: 'Raport częściowy' }),
  ).toBeVisible();
  await expect(page.getByText('Brak streszczeń: ABCDEFGHIJK')).toBeVisible();
  await expect(
    page.getByText(
      'Oczekiwane: 3 · Gotowe transkrypcje: 3 · Przetworzone: 2 · Pominięte: 1',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Polityka', exact: true }).click();
  const section = page.getByRole('region', { name: 'Polityka', exact: true });
  await section.getByText('Opinia autora o wyborach', { exact: true }).click();
  await expect(
    section.getByText('Nieprzetworzono: Nie odczytano całej transkrypcji'),
  ).toBeVisible();
  await expect(section.getByText(summary, { exact: true })).toHaveCount(0);
});
