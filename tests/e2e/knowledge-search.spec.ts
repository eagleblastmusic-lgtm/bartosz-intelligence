import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('entity source chronology and owner decision history page independently without AI calls', async ({
  page,
}) => {
  const origin = 'https://history.fixture.invalid';
  await page.setViewportSize({ width: 360, height: 800 });
  await page.route(origin + '/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      expect(route.request().method()).toBe('GET');
      if (url.pathname.endsWith('/auth/session'))
        return route.fulfill({ json: { authenticated: true } });
      if (url.pathname.endsWith('/timeline'))
        return route.fulfill({
          json: {
            observations: [
              {
                observation_id: 'observation-a',
                kind: 'CLAIM',
                run_id: 'old-accepted',
                item_id: 'item-a',
                source_id: 'source-a',
                published_at: null,
                title: 'History source',
                recorded_at: '2026-10-06T12:00:00Z',
                observation: {
                  content_pl: 'Przytoczona opinia',
                  epistemic_status: 'SOURCE_REPORT',
                  temporal_text: 'w przyszłym roku',
                },
              },
            ],
            cut_seq: '1',
            chronology: 'SOURCE_PUBLICATION_NULL_LAST',
            next_cursor: null,
          },
        });
      if (url.pathname.endsWith('/history'))
        return route.fulfill({
          json: {
            events: [
              {
                event_id: url.searchParams.has('cursor')
                  ? 'event-2'
                  : 'event-1',
                action: 'LABEL_APPLY',
                reason: url.searchParams.has('cursor')
                  ? 'Druga decyzja'
                  : '<b>Powód właściciela</b>',
                authored_by: 'a',
                recorded_at: '2026-10-06T13:00:00Z',
                text: 'Nazwa właściciela',
              },
            ],
            cut_seq: '1',
            chronology: 'OWNER_ACTION_TIME',
            next_cursor: url.searchParams.has('cursor') ? null : 'next',
          },
        });
      expect(url.pathname).toBe('/api/v1/entities/tool-a');
      return route.fulfill({
        json: {
          entity: {
            entity_id: 'tool-a',
            label: 'Tool',
            entity_type: 'TOOL',
            resolution: 'UNRESOLVED_LITERAL',
            effective_entity_id: 'tool-a',
          },
          revision: 0,
          aliases: [],
          history: [],
          identity_history: [],
          aliases_has_more: false,
          history_has_more: false,
          identity_history_has_more: false,
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
  await page.goto(origin + '/entities/tool-a');
  await page
    .getByRole('button', { name: 'Pokaż historię wypowiedzi', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Przytoczona opinia' }),
  ).toBeVisible();
  await expect(
    page.getByText('History source · Data publikacji nieustalona'),
  ).toBeVisible();
  await expect(
    page.getByText('Czas wskazany w źródle: w przyszłym roku'),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Pokaż pełną historię decyzji', exact: true })
    .click();
  await expect(
    page.getByText('<b>Powód właściciela</b>', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Pokaż kolejne decyzje', exact: true })
    .click();
  await expect(page.getByText('Druga decyzja', { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test('search reports unknown and stale coverage, renders literal text, pages read-only and supports keyboard', async ({
  page,
}) => {
  const origin = 'https://search.fixture.invalid';
  const requests: string[] = [];
  await page.setViewportSize({ width: 360, height: 800 });
  await page.route(origin + '/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      expect(route.request().method()).toBe('GET');
      requests.push(url.pathname + url.search);
      if (url.pathname.endsWith('/auth/session'))
        return route.fulfill({ json: { authenticated: true } });
      expect(url.pathname).toBe('/api/v1/search');
      const unknown = url.searchParams.get('q') === 'unknown',
        next = url.searchParams.has('cursor');
      return route.fulfill({
        json: {
          documents: unknown
            ? []
            : [
                {
                  doc_id: next ? 'second' : 'first',
                  parent_id: 'INSIGHT:note',
                  item_id: null,
                  run_id: null,
                  kind: 'INSIGHT',
                  entity_id: null,
                  observation_id: null,
                  text: next
                    ? 'Druga notatka'
                    : '<script>window.injected=true</script> Zażółć',
                  title: null,
                  published_at: null,
                },
              ],
          freshness: unknown ? 'UNKNOWN' : 'STALE',
          indexed_cut: 1,
          current_cut: 2,
          scope:
            'TITLE_TYPED_KNOWLEDGE_MANUAL_NOTES_ENTITIES_ALIASES_ANALYSIS_PREVIEW',
          next_cursor: unknown || next ? null : 'next',
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
  await page.goto(origin + '/search?q=unknown');
  await expect(
    page.getByText('Indeks nie został jeszcze utworzony.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('Brak dopasowań', { exact: false })).toHaveCount(
    0,
  );
  await page.getByRole('searchbox', { name: 'Szukane słowa' }).fill('zazolc');
  await page.getByRole('searchbox', { name: 'Szukane słowa' }).press('Enter');
  await expect(
    page.getByText('<script>window.injected=true</script> Zażółć', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('Indeks wymaga aktualizacji.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Pokaż kolejne wyniki' }).click();
  await expect(page.getByText('Druga notatka', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Object.hasOwn(window, 'injected'))).toBe(
    false,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(requests.some((request) => request.includes('cursor=next'))).toBe(
    true,
  );
});
