import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('owner annotation uses a preview, preserves raw text and reverts without deleting history', async ({
  page,
}) => {
  const origin = 'https://corrections.fixture.invalid';
  let revision = 0,
    effective = 'Literal name',
    posts = 0;
  const history: {
    correction_id: string;
    new_value: string;
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
      if (url.pathname === '/api/v1/entities/entity-a')
        return route.fulfill({
          json: {
            entity: {
              entity_id: 'entity-a',
              label: 'Literal name',
              entity_type: 'TOOL',
              resolution: 'UNRESOLVED_LITERAL',
              effective_entity_id: 'entity-a',
            },
            revision: 0,
            aliases: [],
            history: [],
            identity_history: [],
          },
        });
      expect(url.pathname).toBe('/api/v1/corrections/ENTITY_LABEL/entity-a');
      if (route.request().method() === 'POST') {
        const input = route.request().postDataJSON();
        expect(input.old_value).toBe(effective);
        expect(input.expected_revision).toBe(revision);
        expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
        revision++;
        posts++;
        effective = input.new_value;
        history.unshift({
          correction_id: input.correction_id,
          new_value: effective,
          reason: input.reason,
          recorded_at: '2026-10-06T17:00:00Z',
        });
        return route.fulfill({ json: { revision, duplicate: false } });
      }
      return route.fulfill({
        json: {
          target_kind: 'ENTITY_LABEL',
          target_id: 'entity-a',
          target_hash: 'a'.repeat(64),
          original_value: 'Literal name',
          effective_value: effective,
          revision,
          history,
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
  await page.goto(origin + '/entities/entity-a');
  await page.getByRole('button', { name: 'Korekta nazwy właściciela' }).click();
  const editor = page.getByRole('region', { name: 'Korekta właściciela' });
  await expect(editor.getByText('Oryginał: Literal name')).toBeVisible();
  await editor
    .getByLabel('Tekst korekty')
    .fill('<img src=x onerror="alert(1)">Owner annotation');
  await editor
    .getByLabel('Powód korekty')
    .fill('Verified against original source');
  await editor
    .getByRole('button', { name: 'Podgląd korekty', exact: true })
    .click();
  expect(posts).toBe(0);
  await editor.getByRole('button', { name: 'Potwierdź korektę' }).click();
  await expect(editor.getByLabel('Powód korekty')).toHaveValue('');
  await expect(editor.getByLabel('Tekst korekty')).toHaveValue(effective);
  await expect(editor.locator('img')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Literal name', exact: true }),
  ).toBeVisible();
  await editor
    .getByLabel('Powód korekty')
    .fill('Restore original interpretation');
  await editor
    .getByRole('button', { name: 'Podgląd przywrócenia oryginału' })
    .click();
  await editor.getByRole('button', { name: 'Potwierdź korektę' }).click();
  await expect(editor.getByLabel('Tekst korekty')).toHaveValue('Literal name');
  await editor.getByText('Historia korekt (2)', { exact: true }).click();
  expect(posts).toBe(2);
  expect(history).toHaveLength(2);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
