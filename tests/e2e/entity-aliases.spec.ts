import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('owner previews, confirms and reverses an alias without claiming identity was resolved by AI', async ({
  page,
}) => {
  const origin = 'https://aliases.fixture.invalid';
  let revision = 0,
    action = 'APPROVE',
    posts = 0;
  const events: {
    decision_id: string;
    revision: number;
    action: string;
    normalized_literal: string;
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
      if (url.pathname.endsWith('/entities/tool-a/aliases')) {
        expect(route.request().method()).toBe('POST');
        expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
        const input = route.request().postDataJSON();
        expect(input.expected_revision).toBe(revision);
        expect(input.reason).toBeTruthy();
        expect(input.language).toBeNull();
        posts++;
        revision++;
        action = input.action;
        events.unshift({
          decision_id: input.decision_id,
          revision,
          action,
          normalized_literal: input.literal,
          reason: input.reason,
          recorded_at: '2026-10-06T17:00:00Z',
        });
        return route.fulfill({ json: { revision, duplicate: false } });
      }
      expect(url.pathname).toBe('/api/v1/entities/tool-a');
      return route.fulfill({
        json: {
          entity: {
            entity_id: 'tool-a',
            label: 'Claude',
            entity_type: 'TOOL',
            resolution: 'UNRESOLVED_LITERAL',
          },
          revision,
          aliases: revision
            ? [
                {
                  alias_id: 'alias-a',
                  literal: 'Claude',
                  status: action === 'APPROVE' ? 'APPROVED' : 'REVOKED',
                },
              ]
            : [],
          history: events,
          aliases_has_more: false,
          history_has_more: false,
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
  await expect(
    page.getByRole('heading', { name: 'Claude', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Nazwa literalna — tożsamość nieustalona', { exact: false }),
  ).toBeVisible();
  await page
    .getByLabel('Powód decyzji', { exact: true })
    .fill('Sprawdziłem nazwę w źródle');
  await page.getByRole('button', { name: 'Podgląd zatwierdzenia' }).click();
  expect(posts).toBe(0);
  await expect(
    page.getByRole('region', { name: 'Podgląd decyzji' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Anuluj', exact: true }).click();
  expect(posts).toBe(0);
  await page.getByRole('button', { name: 'Podgląd zatwierdzenia' }).click();
  await page.getByRole('button', { name: 'Potwierdź decyzję' }).click();
  await expect(
    page.getByText('Claude · Zatwierdzony', { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Powód decyzji', { exact: true })
    .fill('Wycofuję niepewny alias');
  await page.getByRole('button', { name: 'Podgląd wycofania' }).click();
  await page.getByRole('button', { name: 'Potwierdź decyzję' }).click();
  await expect(
    page.getByText('Claude · Wycofany', { exact: true }),
  ).toBeVisible();
  expect(posts).toBe(2);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole('link', { name: 'Wypowiedzi i dowody dotyczące tej encji' }),
  ).toHaveAttribute('href', '/ledger?entity_id=tool-a');
  await page.locator('#main-content').focus();
  await page.screenshot({
    path: '.local/gui/cp-6.2-alias-mobile.png',
    fullPage: false,
  });
});
