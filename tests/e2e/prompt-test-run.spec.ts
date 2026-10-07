import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('draft quality test selects exact source, semantic scope and Free revision with review before durable enqueue', async ({
  page,
}) => {
  const origin = 'https://prompt-tests.fixture.invalid',
    family = 'ECONOMY_ANALYSIS_V1';
  let previews = 0,
    confirms = 0;
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
              { version: 3, status: 'DRAFT' },
              { version: 2, status: 'PUBLISHED' },
            ],
          },
        ],
      });
    if (
      url.pathname === '/api/v1/prompts/' + family + '/2' ||
      url.pathname === '/api/v1/prompts/' + family + '/3'
    )
      return route.fulfill({
        json: {
          prompt_id: family,
          version: Number(url.pathname.split('/').at(-1)),
          status: 'DRAFT',
          prompt_hash: 'a'.repeat(64),
          prompt_text: 'Test {{source_text}}',
          required_inputs: ['source_text'],
        },
      });
    if (url.pathname.endsWith('/tests')) return route.fulfill({ json: [] });
    if (url.pathname === '/api/v1/items')
      return route.fulfill({
        json: {
          items: [{ item_id: 'item-1', metadata: { title: 'Source fixture' } }],
          next_cursor: null,
        },
      });
    if (url.pathname === '/api/v1/reprocess/context/item-1')
      return route.fulfill({
        json: {
          available: true,
          source_choices: [
            {
              run_id: 'source-old',
              role: 'SOURCE_ORIGINAL',
              label: 'Original',
            },
            {
              run_id: 'source-new',
              role: 'CORRECTED_SOURCE',
              label: 'Corrected',
            },
          ],
          profiles: [
            {
              profile_id: 'monitor',
              revision: 7,
              name: 'Monitor',
              mode: 'ECONOMY',
              optional_tasks: false,
            },
          ],
          model_profile: {
            profile_id: 'gemini_free',
            revision: 4,
            model: 'fixture-model',
          },
          settings: {
            runtime: 'local',
            mode: 'PRODUCTION',
            purpose: 'personal',
            region: 'PL',
            max_output_tokens: 4000,
            limits: { claims: 40 },
          },
        },
      });
    if (url.pathname === '/api/v1/prompts/tests/preview') {
      expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
      previews++;
      expect(route.request().postDataJSON()).toEqual({
        prompt_id: family,
        version: 3,
        source_run_id: 'source-new',
        semantic_profile_id: 'monitor',
        semantic_profile_revision: 7,
        model_revision: 4,
        max_output_tokens: 2000,
        purpose: 'personal',
        region: 'PL',
        limits: { claims: 10 },
      });
      return route.fulfill({
        json: {
          kind: 'ANALYSIS',
          preview_hash: 'b'.repeat(64),
          prompt_id: family,
          prompt_version: 3,
          model_revision: 4,
          wire_schema_id: 'wire:1.0',
          wire_schema_hash: 'c'.repeat(64),
          quota_status: 'UNKNOWN',
          additional_model_requests: 1,
        },
      });
    }
    if (url.pathname === '/api/v1/reprocess/confirm') {
      expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
      confirms++;
      intents.push(route.request().postDataJSON());
      if (confirms === 1) return route.abort('failed');
      return route.fulfill({ json: { job_id: 'quality-job' } });
    }
    if (url.pathname.startsWith('/api/'))
      throw new Error('UNEXPECTED_TEST_API');
    const local = await fetch('http://127.0.0.1:8787' + url.pathname);
    return route.fulfill({
      status: local.status,
      contentType: local.headers.get('content-type') ?? 'text/plain',
      body: Buffer.from(await local.arrayBuffer()),
    });
  });
  await page.goto(origin + '/system/prompts');
  await page.getByLabel('Wersja bazowa').selectOption('3');
  await page
    .getByText('Przygotuj próbę jakości tej wersji', { exact: true })
    .click();
  await page.getByLabel('Materiał do próby').selectOption('item-1');
  await page.getByLabel('Rewizja źródła').selectOption('source-new');
  await page
    .getByRole('combobox', { name: 'Profil semantyczny', exact: true })
    .selectOption('monitor:7');
  await page.getByLabel('Limit tokenów odpowiedzi do próby').fill('2000');
  await page.getByLabel('Limity modułów do próby (JSON)').fill('{"claims":10}');
  expect(previews).toBe(0);
  expect(confirms).toBe(0);
  await page.getByRole('button', { name: 'Przygotuj podgląd próby' }).click();
  await expect(page.getByRole('status')).toContainText('Quota: UNKNOWN');
  expect(confirms).toBe(0);
  await page
    .getByRole('button', { name: 'Potwierdź zadanie próby jakości' })
    .click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page
    .getByRole('button', { name: 'Potwierdź zadanie próby jakości' })
    .click();
  await expect(page.getByRole('status')).toContainText('quality-job');
  expect(intents[1]).toEqual(intents[0]);
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
