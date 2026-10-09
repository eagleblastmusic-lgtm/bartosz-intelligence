import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('archived material links to Drive without fetching deleted canonical data or scheduling analysis', async ({
  page,
}) => {
  const origin = 'https://retention.fixture.invalid';
  const requested: string[] = [];
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
    const path = new URL(route.request().url()).pathname;
    requested.push(path);
    expect(route.request().method()).toBe('GET');
    if (path.endsWith('/auth/session'))
      return route.fulfill({ json: { authenticated: true } });
    if (path.endsWith('/detail'))
      return route.fulfill({
        json: {
          item_id: 'archived',
          title: 'Archiwalny materiał',
          creator: 'Kanał',
          canonical_url: 'https://www.youtube.com/watch?v=abcdefghijk',
          published_at: '2026-10-01T12:00:00Z',
          analysis_status: 'READY',
          processing_state: 'DONE',
          reason: null,
          selected_run_id: null,
          selection_revision: 1,
          view: null,
          canonical: null,
          semantic_verification: 'NOT_ASSERTED',
          archive: {
            file_id: 'stable-file-id',
            remote_version: '1',
            verified_at: '2026-10-09T12:00:00Z',
            phase: 'COMPLETE',
          },
        },
      });
    if (path.endsWith('/organization'))
      return route.fulfill({
        json: { tags: [], collections: [], notes: [], revision: 0 },
      });
    if (path.endsWith('/tags') || path.endsWith('/collections'))
      return route.fulfill({ json: { items: [], next_cursor: null } });
    throw Error('UNEXPECTED_ARCHIVED_API ' + path);
  });
  await page.goto(origin + '/items/archived');
  const link = page.getByRole('link', {
    name: 'Otwórz raport na Google Drive',
  });
  await expect(link).toHaveAttribute(
    'href',
    'https://drive.google.com/file/d/stable-file-id/view',
  );
  await expect(
    page.getByText('Przyjęty wynik nie jest jeszcze dostępny.', {
      exact: false,
    }),
  ).toHaveCount(0);
  expect(
    requested.some(
      (p) =>
        p.includes('/canonical') ||
        p.includes('/optional') ||
        p.includes('/reprocess'),
    ),
  ).toBe(false);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
});
