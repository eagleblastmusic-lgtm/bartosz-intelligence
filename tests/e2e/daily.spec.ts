import { expect, test } from '@playwright/test';
import type {
  DailySnapshot,
  CalendarSnapshot,
} from '../../packages/contracts/src/daily.js';
test('day/filter URLs, calendar keyboard, delayed responses and retained refresh results', async ({
  page,
}) => {
  const origin = 'https://daily.fixture.invalid';
  await page.clock.install({ time: new Date('2026-10-06T12:00:00Z') });
  let revision = 1,
    fail = false,
    paginated = false;
  const requests: string[] = [];
  const snapshot = (date: string): DailySnapshot => ({
    date,
    timezone: 'Europe/Warsaw',
    cut_seq: revision,
    projection_revision: String(revision),
    counts: { items: 0, ready: 0, pending: 0, blocked: 0, failed: 0 },
    discovery_complete: date === '2026-10-06',
    complete: false,
    partial: true,
    items: [],
    next_cursor: null,
    source_coverage: [],
    freshness: { sampled_at: '2026-10-06T12:00:00Z', status: 'CURRENT' },
  });
  await page.route(origin + '/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await fetch('http://127.0.0.1:8787' + url.pathname);
    await route.fulfill({
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'text/plain',
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    expect(route.request().method()).toBe('GET');
    if (url.pathname.endsWith('/auth/session'))
      return route.fulfill({ json: { authenticated: true } });
    if (url.pathname.endsWith('/sources'))
      return route.fulfill({
        json: {
          sources: [
            { source_id: 'source-a', title: 'Kanał A' },
            { source_id: 'source-b', title: 'Kanał B' },
          ],
          next_cursor: null,
        },
      });
    if (url.pathname.endsWith('/daily/calendar')) {
      const month = url.searchParams.get('month')!;
      const days = Array.from(
        {
          length: new Date(
            Number(month.slice(0, 4)),
            Number(month.slice(5)),
            0,
          ).getDate(),
        },
        (_, i) => ({
          date: month + '-' + String(i + 1).padStart(2, '0'),
          counts: {
            items: i === 5 ? 3 : 0,
            ready: i === 5 ? 1 : 0,
            pending: i === 5 ? 2 : 0,
            blocked: 0,
            failed: 0,
          },
          discovery_complete: i === 5,
          complete: false,
        }),
      );
      const data: CalendarSnapshot = {
        month,
        timezone: 'Europe/Warsaw',
        cut_seq: 1,
        projection_revision: '1',
        days,
        freshness: { sampled_at: '2026-10-06T12:00:00Z', status: 'CURRENT' },
      };
      return route.fulfill({ json: data });
    }
    if (url.pathname.endsWith('/daily')) {
      if (url.searchParams.has('cursor'))
        return route.fulfill({
          status: 409,
          json: { code: 'READ_SNAPSHOT_CHANGED' },
        });
      if (fail)
        return route.fulfill({ status: 503, json: { code: 'TRANSIENT' } });
      const date = url.searchParams.get('date')!;
      if (url.searchParams.get('source_ids') === 'source-a')
        await new Promise((resolve) => setTimeout(resolve, 350));
      try {
        const data = snapshot(date);
        if (revision > 1) {
          data.items = [
            {
              item_id: 'item-new',
              source_id: 'source-a',
              title: 'Nowa publikacja',
              creator: 'Kanał A',
              canonical_url: 'https://www.youtube.com/watch?v=rUhllpnYWR8',
              published_at: '2026-10-06T10:00:00Z',
              publication_provenance: 'youtube',
              duration_seconds: 120,
              metadata_revision: '1',
              selected_run_id: null,
              selection_revision: null,
              analysis_status: 'PENDING',
              reason: null,
              retry_at: null,
              processing_state: 'PENDING',
              view: null,
            },
          ];
          data.counts.items = 1;
          data.counts.pending = 1;
          if (paginated) data.next_cursor = 'fixture-cursor';
        }
        await route.fulfill({ json: data });
      } catch {
        /* An aborted obsolete request must not affect the latest route. */
      }
      return;
    }
    throw new Error('UNEXPECTED_DAILY_API');
  });
  await page.goto(origin + '/daily/2026-10-05');
  await expect(
    page.getByRole('heading', { name: 'Jeszcze nie ma publikacji' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Kalendarz', exact: true }).click();
  const day = page.getByRole('button', {
    name: /poniedziałek, 5 października 2026/,
  });
  await expect(day).toBeFocused();
  await day.press('ArrowRight');
  const next = page.getByRole('button', {
    name: /wtorek, 6 października 2026; 3 materiałów, 1 gotowych, 2 oczekuje/,
  });
  await expect(next).toBeFocused();
  await next.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Kalendarz', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Kalendarz', exact: true }).click();
  await day.press('ArrowRight');
  await next.press('Enter');
  await expect(page).toHaveURL(origin + '/daily/2026-10-06');
  await expect(
    page.getByRole('heading', { name: 'Tego dnia nie znaleziono publikacji' }),
  ).toBeVisible();
  await page.getByLabel('Kanał A', { exact: true }).check();
  await page.getByLabel('Kanał B', { exact: true }).check();
  await expect(page).toHaveURL(/source_ids=source-a%2Csource-b/);
  await expect(
    page.getByRole('heading', { name: 'Tego dnia nie znaleziono publikacji' }),
  ).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.getByLabel('Kanał B', { exact: true })).toBeChecked();
  await page.reload();
  await expect(page.getByLabel('Kanał A', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Wszystkie kanały' }).click();
  await page.goBack();
  await expect(page.getByLabel('Kanał B', { exact: true })).toBeChecked();
  fail = true;
  await page.getByRole('button', { name: 'Odśwież', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Tego dnia nie znaleziono publikacji' }),
  ).toBeVisible();
  fail = false;
  revision = 2;
  paginated = true;
  await page.clock.runFor(31000);
  const update = page.getByRole('button', {
    name: '1 nowych materiałów · Zastosuj zmiany',
  });
  await expect(update).toBeVisible();
  await expect(page.getByRole('link', { name: 'Nowa publikacja' })).toHaveCount(
    0,
  );
  await update.click();
  await expect(
    page.getByRole('link', { name: 'Nowa publikacja' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Pokaż więcej' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Dane zmieniły się podczas przeglądania. Odśwież widok.',
  );
  await expect(page.getByRole('link', { name: 'Nowa publikacja' })).toHaveCount(
    1,
  );
  await page.getByRole('button', { name: 'Kalendarz', exact: true }).click();
  for (const width of [1440, 1024, 768, 360]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.screenshot({
    path: '.local/gui/cp-4.3-calendar-mobile.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Zamknij kalendarz' }).click();
  await page.getByRole('button', { name: 'Wczoraj', exact: true }).click();
  await expect(page).toHaveURL(/\/daily\/2026-10-05\?/);
  await page.getByRole('button', { name: 'Dzisiaj', exact: true }).click();
  await expect(page).toHaveURL(/\/daily\/2026-10-06\?/);
  expect(
    requests.every(
      (value) => !value.includes('analy') && !value.includes('generate'),
    ),
  ).toBe(true);
});
