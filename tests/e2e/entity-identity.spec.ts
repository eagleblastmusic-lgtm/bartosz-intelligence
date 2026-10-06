import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('identity merge, split and undo require owner preview and confirmation', async ({
  page,
}) => {
  const origin = 'https://identity.fixture.invalid';
  let effective = 'entity-a',
    confirmed = 0;
  const events: {
    event_id: string;
    action: string;
    reason: string;
    recorded_at: string;
  }[] = [];
  await page.context().addCookies([
    {
      name: '__Host-bi-csrf',
      value: 'fixture-csrf',
      url: origin + '/',
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.route(origin + '/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname.endsWith('/auth/session'))
        return route.fulfill({ json: { authenticated: true } });
      if (url.pathname === '/api/v1/entities')
        return route.fulfill({
          json: {
            entities: [
              {
                entity_id: 'entity-b',
                label: 'Shared tool',
                entity_type: 'TOOL',
                effective_entity_id: 'entity-b',
              },
            ],
            next_cursor: null,
          },
        });
      if (url.pathname === '/api/v1/entities/identity-preview') {
        const input = route.request().postDataJSON();
        expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
        return route.fulfill({
          json: {
            ...input,
            event_id: crypto.randomUUID(),
            expected: [
              { entity_id: 'entity-a', label: 'Literal tool' },
              { entity_id: 'entity-b', label: 'Shared tool' },
            ],
            mappings: [],
            impact: { observations: 4, aliases: 2 },
          },
        });
      }
      if (url.pathname === '/api/v1/entities/identity-confirm') {
        const input = route.request().postDataJSON();
        expect(input.reason).toBeTruthy();
        confirmed++;
        effective = input.action === 'MERGE' ? 'entity-b' : 'entity-a';
        events.unshift({
          event_id: input.event_id,
          action: input.action,
          reason: input.reason,
          recorded_at: '2026-10-06T17:00:00Z',
        });
        return route.fulfill({ json: { duplicate: false } });
      }
      expect(url.pathname).toBe('/api/v1/entities/entity-a');
      return route.fulfill({
        json: {
          entity: {
            entity_id: 'entity-a',
            label: 'Literal tool',
            entity_type: 'TOOL',
            resolution: 'UNRESOLVED_LITERAL',
            effective_entity_id: effective,
          },
          revision: 0,
          aliases: [],
          history: [],
          identity_history: events,
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
  await page.goto(origin + '/entities/entity-a');
  await page.getByRole('button', { name: 'Wybierz encję do scalenia' }).click();
  await page
    .getByRole('combobox', { name: 'Wspólna encja' })
    .selectOption('entity-b');
  await page
    .getByLabel('Powód zmiany tożsamości')
    .fill('Owner reviewed identity');
  await page.getByRole('button', { name: 'Podgląd scalenia' }).click();
  await expect(
    page.getByRole('region', { name: 'Podgląd tożsamości' }),
  ).toBeVisible();
  expect(confirmed).toBe(0);
  await page.getByRole('button', { name: 'Anuluj zmianę tożsamości' }).click();
  expect(confirmed).toBe(0);
  await page.getByRole('button', { name: 'Podgląd scalenia' }).click();
  await page
    .getByRole('button', { name: 'Potwierdź zmianę tożsamości' })
    .click();
  await expect(
    page.getByRole('link', { name: 'Otwórz wspólną tożsamość' }),
  ).toBeVisible();
  await page
    .getByLabel('Powód zmiany tożsamości')
    .fill('Owner separates literal');
  await page
    .getByRole('button', { name: 'Podgląd wydzielenia tej encji' })
    .click();
  await page
    .getByRole('button', { name: 'Potwierdź zmianę tożsamości' })
    .click();
  await expect(
    page.getByRole('link', { name: 'Otwórz wspólną tożsamość' }),
  ).toHaveCount(0);
  await page
    .getByLabel('Powód zmiany tożsamości')
    .fill('Owner reverses change');
  await page
    .getByRole('button', { name: 'Podgląd cofnięcia tej zmiany' })
    .first()
    .click();
  await page
    .getByRole('button', { name: 'Potwierdź zmianę tożsamości' })
    .click();
  expect(confirmed).toBe(3);
  await expect(
    page.getByRole('heading', { name: 'Literal tool', exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
