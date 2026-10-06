import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
test('reading verifies paged canonical bytes, preserves accepted text on failure and renders source attribution', async ({
  page,
}) => {
  const origin = 'https://reading.fixture.invalid',
    digest = (value: Buffer) =>
      createHash('sha256').update(value).digest('hex');
  let corrupt = false,
    disabled = false;
  const requests: number[] = [];
  const canonical = () => ({
    schema_version: '1.2',
    item_id: 'item-reading',
    source_artifact_id: 'source',
    profile_id: 'ECONOMY',
    profile_revision: '1',
    status: 'OK',
    source_issues: [],
    enabled_modules: disabled
      ? ['claims']
      : [
          'summary',
          'key_points',
          'entities',
          'tools',
          'claims',
          'stance',
          'predictions',
        ],
    summary_pl: disabled
      ? []
      : [
          {
            text_pl:
              'Zaakceptowana notatka. ' +
              'Długi polski tekst ze źródła. '.repeat(5000),
            evidence_ids: [],
          },
        ],
    key_points: [],
    entities: [],
    tools: [],
    claims: [
      {
        observation_id: 'claim-a',
        content_pl: '<img src=x onerror=alert(1)> Autor nie wdrożył narzędzia.',
        attribution: 'SOURCE_SPEAKER',
        qualifiers: ['negacja', 'tylko w projekcie testowym'],
        prediction_horizon: null,
        stance_polarity: null,
        evidence_ids: ['evidence-a'],
      },
    ],
    stance: [],
    predictions: [],
  });
  await page.route(origin + '/**', async (route) => {
    const local = await fetch(
      'http://127.0.0.1:8787' + new URL(route.request().url()).pathname,
    );
    await route.fulfill({
      status: local.status,
      contentType: local.headers.get('content-type') ?? 'text/plain',
      body: Buffer.from(await local.arrayBuffer()),
    });
  });
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    expect(route.request().method()).toBe('GET');
    if (url.pathname.endsWith('/auth/session'))
      return route.fulfill({ json: { authenticated: true } });
    const bytes = Buffer.from(JSON.stringify(canonical())),
      count = Math.ceil(bytes.length / 32768),
      descriptor = {
        artifact_id: 'canonical',
        content_hash: digest(bytes),
        byte_size: bytes.length,
        chunk_count: count,
        schema_version: 'intelligence-canonical:1.2',
      };
    if (url.pathname.endsWith('/detail'))
      return route.fulfill({
        json: {
          item_id: 'item-reading',
          title: 'Źródłowa analiza narzędzia',
          creator: 'Autor',
          canonical_url: 'https://www.youtube.com/watch?v=rUhllpnYWR8',
          published_at: null,
          analysis_status: 'READY',
          processing_state: 'DEFERRED',
          reason: null,
          selected_run_id: 'run-reading',
          selection_revision: 1,
          view: null,
          canonical: descriptor,
          semantic_verification: 'NOT_ASSERTED',
        },
      });
    if (url.pathname.endsWith('/canonical')) {
      expect(url.searchParams.get('run_id')).toBe('run-reading');
      const start = Number(url.searchParams.get('start'));
      requests.push(start);
      const chunks = Array.from(
        { length: Math.min(4, count - start) },
        (_, at) => {
          const index = start + at,
            part = bytes.subarray(index * 32768, (index + 1) * 32768);
          return {
            chunk_index: index,
            byte_start: index * 32768,
            byte_size: part.length,
            byte_hash: corrupt ? '0'.repeat(64) : digest(part),
            body_base64: part.toString('base64url'),
          };
        },
      );
      return route.fulfill({
        json: {
          descriptor,
          chunks,
          next_index:
            start + chunks.length < count ? start + chunks.length : null,
        },
      });
    }
    throw new Error('UNEXPECTED_READING_API');
  });
  await page.goto(
    origin +
      '/items/item-reading?return=%2Fdaily%2F2026-10-05%3Fdensity%3Dcompact',
  );
  await expect(
    page.getByRole('heading', { name: 'Źródłowa analiza narzędzia' }),
  ).toBeVisible();
  await expect(page.getByText(/^Zaakceptowana notatka/)).toBeVisible();
  expect(requests).toEqual([0, 4]);
  await expect(
    page.getByText('Wypowiedź źródła', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Warunki i zastrzeżenia: negacja · tylko w projekcie testowym/,
    ),
  ).toBeVisible();
  expect(await page.locator('img').count()).toBe(0);
  await expect(
    page.getByRole('link', { name: '← Powrót do dnia' }),
  ).toHaveAttribute('href', '/daily/2026-10-05?density=compact');
  corrupt = true;
  await page.getByRole('button', { name: 'Odśwież wynik' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText(/^Zaakceptowana notatka/)).toBeVisible();
  corrupt = false;
  disabled = true;
  await page.getByRole('button', { name: 'Odśwież wynik' }).click();
  await expect(
    page.getByText('Podsumowanie wyłączono w profilu.'),
  ).toBeVisible();
  await expect(page.getByText(/^Zaakceptowana notatka/)).toHaveCount(0);
  await expect(
    page.getByText('Wypowiedź źródła', { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 360, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '.local/gui/cp-4.5-reading-mobile.png',
    fullPage: true,
  });
  corrupt = true;
  await page.reload();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('Wypowiedź źródła', { exact: true })).toHaveCount(
    0,
  );
});
