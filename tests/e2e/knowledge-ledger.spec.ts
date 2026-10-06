import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('Ledger renders attributed rows, source/date filters and pagination without generation requests', async ({
  page,
}) => {
  const origin = 'https://ledger.fixture.invalid';
  const requests: string[] = [];
  await page.setViewportSize({ width: 360, height: 800 });
  await page.route(origin + '/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      expect(route.request().method()).toBe('GET');
      requests.push(url.pathname + url.search);
      if (url.pathname.endsWith('/auth/session'))
        return route.fulfill({ json: { authenticated: true } });
      if (url.pathname.endsWith('/sources'))
        return route.fulfill({
          json: {
            sources: [{ source_id: 'source-a', title: 'Kanał A' }],
            next_cursor: null,
          },
        });
      expect(url.pathname).toBe('/api/v1/ledger');
      const filtered = url.searchParams.get('kind') === 'STANCE';
      const next = url.searchParams.has('cursor');
      return route.fulfill({
        json: {
          version: 'observation-ledger:1',
          cut_seq: '1',
          sampled_at: '2026-10-06T12:00:00Z',
          observations: filtered
            ? []
            : [
                {
                  observation_id: next ? 'obs-2' : 'obs-1',
                  kind: 'CLAIM',
                  run_id: 'accepted',
                  item_id: 'item-a',
                  source_id: 'source-a',
                  title: 'Film A',
                  creator: 'Kanał A',
                  published_at: null,
                  selection_revision: 1,
                  observation: {
                    content_pl: next
                      ? 'Druga wypowiedź'
                      : 'Źródło relacjonuje cudzą opinię',
                    epistemic_status: 'SOURCE_REPORT',
                    qualifiers: ['pod warunkiem'],
                    temporal_text: null,
                  },
                },
              ],
          next_cursor: filtered || next ? null : 'next',
        },
      });
    }
    const response = await fetch('http://127.0.0.1:8787' + url.pathname);
    return route.fulfill({
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'text/plain',
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  await page.goto(origin + '/ledger');
  await expect(
    page.getByRole('heading', { name: 'Źródło relacjonuje cudzą opinię' }),
  ).toBeVisible();
  await expect(
    page.getByText('Twierdzenie · Relacja o cudzej wypowiedzi'),
  ).toBeVisible();
  await expect(
    page.getByText('Kanał A · Data publikacji nieustalona'),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Otwórz analizę i dowody: Film A' }),
  ).toHaveAttribute('href', /return=%2Fledger$/);
  await page.getByRole('button', { name: 'Pokaż więcej wypowiedzi' }).click();
  await expect(
    page.getByRole('heading', { name: 'Druga wypowiedź' }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '.local/gui/cp-6.1-ledger-mobile.png',
    fullPage: true,
  });
  await page
    .getByRole('combobox', { name: 'Źródło', exact: true })
    .selectOption('source-a');
  await page
    .getByRole('combobox', { name: 'Rodzaj', exact: true })
    .selectOption('STANCE');
  await expect(
    page.getByText('Brak wypowiedzi w wybranym zakresie.', { exact: false }),
  ).toBeVisible();
  expect(page.url()).toContain('source_id=source-a');
  expect(page.url()).toContain('kind=STANCE');
  await page.getByLabel('Data publikacji', { exact: true }).fill('2026-10-05');
  await expect(page).toHaveURL(/date=2026-10-05/);
  await page.getByRole('button', { name: 'Odśwież wiedzę' }).click();
  await expect(
    page.getByRole('button', { name: 'Odśwież wiedzę' }),
  ).toBeEnabled();
  expect(
    requests.some(
      (path) =>
        path.includes('date=2026-10-05') && path.includes('source_id=source-a'),
    ),
  ).toBe(true);
  expect(requests.some((path) => /generate|analyze|lab/.test(path))).toBe(
    false,
  );
});
