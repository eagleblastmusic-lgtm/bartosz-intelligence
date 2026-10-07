import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('publication requires review, preserves confirmation nonce after a lost response, and supports explicit rollback', async ({
  page,
}) => {
  const origin = 'https://prompt-publication.fixture.invalid',
    family = 'ECONOMY_ANALYSIS_V1';
  let status = 'TESTED',
    confirms = 0,
    previews = 0;
  let withdrawn = false;
  const intents: unknown[] = [];
  await page.context().addCookies([
    {
      name: '__Host-bi-csrf',
      value: 'fixture-csrf',
      url: origin,
      secure: true,
    },
  ]);
  await page.route(origin + '/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/auth/session')
      return route.fulfill({ json: { authenticated: true } });
    if (url.pathname === '/api/v1/prompts')
      return route.fulfill({
        json: [
          {
            prompt_id: family,
            wire_schema_id: 'wire:1.0',
            canonical_schema_id: 'canonical:1.2',
            versions: [
              { version: 8, status },
              { version: 2, status: 'PUBLISHED' },
            ],
          },
        ],
      });
    if (
      url.pathname === '/api/v1/prompts/' + family + '/8' ||
      url.pathname === '/api/v1/prompts/' + family + '/2'
    )
      return route.fulfill({
        json: {
          prompt_id: family,
          version: Number(url.pathname.split('/').at(-1)),
          status: url.pathname.endsWith('/8') ? status : 'PUBLISHED',
          usage_restriction:
            withdrawn && url.pathname.endsWith('/8')
              ? {
                  reason: 'Regressed prompt',
                  created_at: '2026-10-07T12:00:00Z',
                }
              : null,
          prompt_hash: 'a'.repeat(64),
          prompt_text: 'Version eight {{source_text}}',
          required_inputs: ['source_text'],
        },
      });
    if (url.pathname.endsWith('/tests'))
      return route.fulfill({
        json: [
          {
            report_hash: 'b'.repeat(64),
            report: {
              run_id: 'verified-fixture-run',
              created_at: '2026-10-07T12:00:00Z',
              quality_scope: 'c'.repeat(64),
              usage: { total_tokens: 200 },
            },
          },
        ],
      });
    if (url.pathname === '/api/v1/prompts/publication/preview') {
      expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
      previews++;
      const input = route.request().postDataJSON();
      expect(input).toMatchObject({
        prompt_id: family,
        version: 8,
        reason: 'Qualified version',
      });
      return route.fulfill({
        json: {
          preview_hash: (previews === 1 ? 'd' : 'e').repeat(64),
          action: input.action,
          prompt_id: family,
          target_version: 8,
          expected_generation: 7,
          new_model_requests: 0,
          reprocess_jobs: 0,
          selection_effect: 'NONE',
        },
      });
    }
    if (url.pathname === '/api/v1/prompts/publication/confirm') {
      expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
      intents.push(route.request().postDataJSON());
      confirms++;
      status = 'PUBLISHED';
      if (confirms === 1) return route.abort('failed');
      return route.fulfill({ json: { generation: 8, version: 8 } });
    }
    if (url.pathname === '/api/v1/prompts/deprecate') {
      expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
      expect(route.request().postDataJSON()).toEqual({
        prompt_id: family,
        version: 8,
        expected_hash: 'a'.repeat(64),
        reason: 'Regressed prompt',
      });
      withdrawn = true;
      return route.fulfill({ json: { receipt_hash: 'f'.repeat(64) } });
    }
    if (url.pathname.startsWith('/api/'))
      throw new Error('UNEXPECTED_PUBLICATION_API');
    const local = await fetch('http://127.0.0.1:8787' + url.pathname);
    return route.fulfill({
      status: local.status,
      contentType: local.headers.get('content-type') ?? 'text/plain',
      body: Buffer.from(await local.arrayBuffer()),
    });
  });
  await page.goto(origin + '/system/prompts');
  await page.getByLabel('Wersja bazowa').selectOption('8');
  await page.getByText('Testy i publikacja wersji 8', { exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Przygotuj publikację' }),
  ).toBeDisabled();
  await page
    .getByLabel('Powód publikacji lub rollbacku')
    .fill('Qualified version');
  await page.getByRole('button', { name: 'Przygotuj publikację' }).click();
  expect(confirms).toBe(0);
  await expect(page.getByRole('status')).toContainText('Nowe wywołania AI: 0');
  await page.getByRole('button', { name: 'Potwierdź publikację' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Potwierdź publikację' }).click();
  await expect(page.getByText('Stan wersji 8: Opublikowana.')).toBeVisible();
  expect(intents[1]).toEqual(intents[0]);
  await page.getByText('Testy i publikacja wersji 8', { exact: true }).click();
  await page
    .getByLabel('Powód publikacji lub rollbacku')
    .fill('Qualified version');
  await page
    .getByRole('button', { name: 'Przygotuj rollback do tej wersji' })
    .click();
  expect(confirms).toBe(2);
  await page.getByRole('button', { name: 'Anuluj', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Potwierdź rollback' }),
  ).toHaveCount(0);
  await page
    .getByText('Wycofanie wersji z nowych użyć', { exact: true })
    .click();
  await page.getByLabel('Powód wycofania wersji').fill('Regressed prompt');
  await page.getByRole('button', { name: 'Przygotuj wycofanie' }).click();
  expect(withdrawn).toBe(false);
  await page
    .getByRole('button', { name: 'Potwierdź wycofanie wersji' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Przygotuj wycofanie' }),
  ).toHaveCount(0);
  await page
    .getByText('Wycofanie wersji z nowych użyć', { exact: true })
    .click();
  await expect(
    page.getByText(/Wersja 8 wycofana: Regressed prompt/),
  ).toBeVisible();
  await page.setViewportSize({ width: 360, height: 900 });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
