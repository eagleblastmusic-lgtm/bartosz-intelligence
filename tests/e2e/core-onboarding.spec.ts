import { test, expect } from '@playwright/test';

test('onboarding preserves preview window/idempotency on retry and renders metadata as text', async ({
  page,
}) => {
  let saves = 0;
  let previewError = '';
  const ranges: unknown[] = [];
  const keys: string[] = [],
    windows: unknown[] = [];
  const window = {
    window_start: '2026-09-05T17:30:00.000Z',
    window_end: '2026-10-05T17:30:00.000Z',
  };
  const title = '<img src=x onerror=alert(1)> Fixture channel';
  // Preserve the real Secure/__Host cookie contract in an isolated HTTPS fixture.
  // Only public built Assets are served from the local test server; APIs are mocked below.
  const fixtureOrigin = 'https://onboarding.fixture.invalid';
  await page.route(fixtureOrigin + '/**', async (route) => {
    const local = await fetch(
      'http://127.0.0.1:8787' + new URL(route.request().url()).pathname,
    );
    await route.fulfill({
      status: local.status,
      contentType: local.headers.get('content-type') ?? 'text/plain',
      body: Buffer.from(await local.arrayBuffer()),
    });
  });
  await page.context().addCookies([
    {
      name: '__Host-bi-csrf',
      value: 'fixture-csrf',
      url: fixtureOrigin + '/',
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let data: unknown;
    if (path === '/api/v1/auth/session') data = { authenticated: true };
    else if (path === '/api/v1/sources/resolve')
      data = { namespace: 'youtube', external_id: 'UC-fixture', title };
    else if (path === '/api/v1/sources/backfill-preview') {
      ranges.push(request.postDataJSON().range);
      if (previewError)
        return route.fulfill({
          status: previewError === 'INVALID_WINDOW' ? 422 : 503,
          json: { code: previewError },
        });
      data = {
        window,
        coverage: 'PARTIAL',
        enumerated_count: 3,
        unknown_publication_count: 1,
      };
    } else if (path === '/api/v1/sources' && request.method() === 'POST') {
      saves++;
      keys.push(request.headers()['idempotency-key']!);
      windows.push(request.postDataJSON().window);
      expect(request.headers()['x-csrf-token']).toBe('fixture-csrf');
      if (saves === 1) {
        await route.fulfill({ status: 503, json: { code: 'TRANSIENT' } });
        return;
      }
      data = { source_id: 'source-fixture', job_id: 'job-fixture' };
    } else if (path === '/api/v1/sources')
      data = {
        sources:
          saves > 1
            ? [
                {
                  source_id: 'source-fixture',
                  title,
                  enabled: 1,
                  last_complete_window_end: null,
                },
              ]
            : [],
        next_cursor: null,
      };
    else if (path === '/api/v1/jobs')
      data = {
        jobs:
          saves > 1
            ? [
                {
                  job_id: 'job-fixture',
                  task_type: 'DISCOVER',
                  state: 'PENDING',
                  reason_code: null,
                },
              ]
            : [],
        next_cursor: null,
      };
    else if (path === '/api/v1/sources/source-fixture/progress')
      data = {
        source_id: 'source-fixture',
        sampled_at: '2026-10-06T12:00:00Z',
        counts: { items: 3, ready: 0, pending: 3, blocked: 0, failed: 0 },
        scan: null,
        scheduled: 0,
        total: null,
      };
    else throw new Error('UNEXPECTED_FIXTURE_API_ROUTE');
    await route.fulfill({ json: data });
  });
  await page.goto(fixtureOrigin + '/channels');
  await page.getByLabel('Adres, @handle lub ID kanału').fill('@fixture');
  await page.getByRole('button', { name: 'Sprawdź ostatnie 30 dni' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByText(/częściowe; discovery/)).toBeVisible();
  expect(await page.locator('img').count()).toBe(0);
  const save = page.getByRole('button', {
    name: 'Włącz monitoring i backfill 30 dni',
  });
  await save.click();
  await expect(page.getByRole('alert')).toContainText('TRANSIENT');
  await save.click();
  const receipt = page
    .getByRole('status')
    .filter({ hasText: 'Monitoring zapisany' });
  await expect(receipt).toBeVisible();
  await expect(page.getByText('DISCOVER · PENDING')).toBeVisible();
  await expect(
    page.getByText(
      'Discovery oczekuje na rozpoczęcie. Łączna liczba materiałów nieznana.',
    ),
  ).toBeVisible();
  await expect(receipt).toContainText('source-fixture');
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(windows).toEqual([window, window]);
  expect(ranges).toEqual([30]);
  previewError = 'QUOTA';
  await page.getByLabel('Zakres', { exact: true }).selectOption('7');
  await page.getByRole('button', { name: 'Sprawdź wybrany zakres' }).click();
  await expect(page.getByRole('alert')).toContainText('QUOTA');
  previewError = '';
  await page.getByRole('button', { name: 'Sprawdź wybrany zakres' }).click();
  await expect(
    page.getByRole('button', { name: 'Włącz monitoring i backfill 7 dni' }),
  ).toBeVisible();
  previewError = 'INVALID_WINDOW';
  await page.getByLabel('Zakres', { exact: true }).selectOption('custom');
  await page.getByLabel('Początek (UTC)').fill('2026-10-07T12:00');
  await page.getByLabel('Koniec (UTC)').fill('2026-10-06T12:00');
  await page.getByRole('button', { name: 'Sprawdź wybrany zakres' }).click();
  await expect(page.getByRole('alert')).toContainText('Sprawdź zakres');
  expect(ranges).toEqual([30, 7, 7, 'custom']);
});

test('unauthenticated screen exposes login without private source data', async ({
  page,
}) => {
  let domainRequests = 0;
  await page.route('**/api/v1/**', async (route) => {
    if (!route.request().url().endsWith('/auth/session')) domainRequests++;
    await route.fulfill({ status: 401, json: { code: 'UNAUTHENTICATED' } });
  });
  await page.goto('/');
  await expect(
    page.getByRole('link', { name: 'Zaloguj się przez Google' }),
  ).toHaveAttribute('href', '/api/v1/auth/login');
  await expect(page.getByLabel('Adres, @handle lub ID kanału')).toHaveCount(0);
  expect(domainRequests).toBe(0);
});
