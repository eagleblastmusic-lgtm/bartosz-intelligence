import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
test('optional tasks require preview/confirm, reuse nonce after a lost reply and read pinned helper/history safely', async ({
  page,
}) => {
  const origin = 'https://optional.fixture.invalid';
  const digest = (data: Buffer) =>
    createHash('sha256').update(data).digest('hex');
  let reads = 0,
    confirms = 0;
  const intents: unknown[] = [];
  const reprocessIntents: unknown[] = [];
  let reprocessReads = 0;
  await page.context().addCookies([
    {
      name: '__Host-bi-csrf',
      value: 'fixture-csrf',
      url: origin,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
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
    if (url.pathname.includes('/reprocess/context/')) {
      reprocessReads++;
      return route.fulfill({
        json: {
          source_run_id: 'source-run',
          source_choices: [
            {
              run_id: 'source-run',
              role: 'SOURCE_ORIGINAL',
              label: 'Oryginalny zapis źródła',
            },
            {
              run_id: 'corrected-run',
              role: 'CORRECTED_SOURCE',
              label: 'Poprawka właściciela',
            },
          ],
          candidate_run_id: 'accepted-run',
          available: true,
          settings: {
            runtime: 'local',
            mode: 'PRODUCTION',
            purpose: 'personal',
            region: 'PL',
            max_output_tokens: 1000,
            limits: { claims: 20 },
          },
          profiles: [
            {
              profile_id: 'custom',
              revision: 1,
              name: 'Custom',
              mode: 'CUSTOM',
              second_pass: true,
              validation_pass: true,
              optional_tasks: false,
            },
          ],
          has_more: false,
        },
      });
    }
    if (url.pathname === '/api/v1/reprocess/preview') {
      const corrected =
        route.request().postDataJSON().source_run_id === 'corrected-run';
      expect(route.request().postDataJSON()).toMatchObject({
        source_run_id: corrected ? 'corrected-run' : 'source-run',
        semantic_profile_id: 'custom',
        semantic_profile_revision: 1,
        pass: corrected
          ? null
          : { mode: 'VALIDATE', candidate_run_id: 'accepted-run' },
      });
      return route.fulfill({
        json: {
          preview_hash: 'a'.repeat(64),
          item_id: 'item',
          pass: 'VALIDATE',
          token_estimate: { input: 1200 },
          quota_status: 'UNKNOWN',
          quota_remaining: null,
          additional_model_requests: 1,
          selection_effect: 'NONE_UNTIL_EXPLICIT_SELECTION',
        },
      });
    }
    if (url.pathname === '/api/v1/reprocess/confirm') {
      expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
      reprocessIntents.push(route.request().postDataJSON());
      return route.fulfill(
        reprocessIntents.length === 1
          ? { status: 503, json: { code: 'TEMPORARY_FAILURE' } }
          : {
              status: 201,
              json: { job_id: 'additional-pass', state: 'PENDING' },
            },
      );
    }
    if (url.pathname.endsWith('/auth/session'))
      return route.fulfill({ json: { authenticated: true } });
    if (url.pathname.endsWith('/detail'))
      return route.fulfill({
        json: {
          item_id: 'item',
          title: 'Materiał testowy',
          creator: 'Autor',
          canonical_url: 'https://www.youtube.com/watch?v=rUhllpnYWR8',
          published_at: null,
          analysis_status: 'PENDING',
          processing_state: 'DEFERRED',
          reason: null,
          selected_run_id: null,
          selection_revision: null,
          view: null,
          canonical: null,
          semantic_verification: 'NOT_ASSERTED',
        },
      });
    if (url.pathname.endsWith('/capabilities')) {
      reads++;
      return route.fulfill({
        json: {
          tasks: ['TRANSLATE', 'HISTORICAL_COMPARE'].map((task) => ({
            task,
            adapter_available: true,
            preview_available: true,
          })),
        },
      });
    }
    if (url.pathname.includes('/results/'))
      return route.fulfill({
        json: {
          recoveries: [
            { run_id: 'partial', generation: 0, expected: 2, translated: 1 },
            { run_id: 'exhausted', generation: 3, expected: 2, translated: 1 },
          ],
          results: [
            {
              run_id: 'translation',
              task_type: 'TRANSLATE',
              created_at: '2026-10-05T00:00:00Z',
            },
            {
              run_id: 'history',
              task_type: 'HISTORICAL_COMPARE',
              created_at: '2026-10-05T00:00:00Z',
            },
          ],
        },
      });
    if (url.pathname === '/api/v1/optional/recovery/preview') {
      expect(route.request().postDataJSON()).toEqual({ run_id: 'partial' });
      expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
      return route.fulfill({
        json: {
          preview_hash: 'e'.repeat(64),
          task: 'TRANSLATE',
          item_id: 'item',
          token_estimate: { input_tokens: 400, output_tokens: 1000 },
          quota_status: 'UNKNOWN',
          additional_model_requests: 1,
          selection_effect: 'NONE',
          source_scope: 'CHUNK',
          scope_count: 1,
        },
      });
    }
    if (url.pathname.endsWith('/preview')) {
      expect(route.request().postDataJSON()).toEqual({
        item_id: 'item',
        task: 'TRANSLATE',
        scope: 'SELECTED_SEGMENTS',
      });
      return route.fulfill({
        json: {
          preview_hash: 'f'.repeat(64),
          task: 'TRANSLATE',
          item_id: 'item',
          token_estimate: { input_tokens: 800, output_tokens: 1000 },
          quota_status: 'UNKNOWN',
          additional_model_requests: 1,
          selection_effect: 'NONE',
          source_scope: 'SELECTED_SEGMENTS',
          scope_count: 1,
        },
      });
    }
    if (url.pathname.endsWith('/confirm')) {
      expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
      intents.push(route.request().postDataJSON());
      confirms++;
      return confirms === 1
        ? route.fulfill({ status: 503, json: { code: 'TRANSIENT' } })
        : route.fulfill({ json: { job_id: 'optional-job' } });
    }
    if (url.pathname.includes('/result/')) {
      const translated = url.pathname.endsWith('/translation');
      const canonical = translated
        ? {
            schema_version: '1.0',
            status: 'OK',
            source_artifact_id: 'source',
            source_language: 'en',
            target_language: 'pl',
            scope: 'SELECTED_SEGMENTS',
            translated_segments: [
              {
                source_segment_id: 'segment',
                text_pl: '<img src=x onerror=alert(1)> Nie używano.',
                issues: ['ASR_UNCERTAIN'],
              },
            ],
            limitations_pl: [],
          }
        : {
            schema_version: '1.0',
            status: 'OK',
            current_item_id: 'item',
            compared_item_ids: ['prior'],
            scope_note_pl: 'Ograniczony kontekst kanału.',
            relations: [
              {
                local_id: 'relation',
                relation_type: 'NOT_COMPARABLE',
                current_observation_refs: ['current'],
                prior_observation_refs: ['previous'],
                current_evidence_refs: ['current-evidence'],
                prior_evidence_refs: ['prior-evidence'],
                explanation_pl: 'Brak wzmianki nie oznacza zmiany stanowiska.',
                qualifiers: ['różny zakres'],
              },
            ],
            limitations_pl: ['Nie cała historia.'],
          };
      const evidence = (id: string) => ({
        evidence_id: id,
        source_artifact_id: 'source',
        source_hash: 'a'.repeat(64),
        segment_ids: ['segment'],
        quote_original: 'Original statement.',
        quote_pl: null,
        start_ms: null,
        end_ms: null,
        timestamp_precision: 'NONE',
        timestamp_url: null,
        quote_hash: 'b'.repeat(64),
      });
      const data = Buffer.from(JSON.stringify(canonical));
      return route.fulfill({
        json: {
          run_id: translated ? 'translation' : 'history',
          item_id: 'item',
          context: translated
            ? {
                task: 'TRANSLATE',
                source_artifact_id: 'source',
                segments: [
                  {
                    source_segment_id: 'segment',
                    start_ms: null,
                    end_ms: null,
                    timestamp_precision: 'NONE',
                  },
                ],
              }
            : {
                task: 'HISTORICAL_COMPARE',
                cut: '2026-10-05T00:00:00Z',
                observations: [
                  {
                    observation_id: 'current',
                    content_pl: 'Bieżąca wypowiedź.',
                    item_id: 'item',
                    run_id: 'current-run',
                    evidence: [evidence('current-evidence')],
                  },
                  {
                    observation_id: 'previous',
                    content_pl: 'Poprzednia wypowiedź.',
                    item_id: 'prior',
                    run_id: 'prior-run',
                    evidence: [evidence('prior-evidence')],
                  },
                ],
              },
          descriptor: {
            artifact_id: 'canonical',
            content_hash: digest(data),
            byte_size: data.length,
            chunk_count: 1,
            schema_version: translated ? 'translation:1.0' : 'historical:1.0',
          },
          chunks: [
            {
              chunk_index: 0,
              byte_start: 0,
              byte_size: data.length,
              byte_hash: digest(data),
              body_base64: data.toString('base64url'),
            },
          ],
          next_index: null,
        },
      });
    }
    if (url.pathname.startsWith('/api/v1/evidence/')) {
      expect(url.pathname).toBe('/api/v1/evidence/prior-evidence');
      expect(url.searchParams.get('run_id')).toBe('prior-run');
      return route.fulfill({ status: 403, json: { code: 'FORBIDDEN' } });
    }
    throw new Error('UNEXPECTED_OPTIONAL_API');
  });
  await page.goto(origin + '/items/item');
  await expect(
    page.getByRole('heading', { name: 'Materiał testowy' }),
  ).toBeVisible();
  expect(reads).toBe(0);
  await page.getByRole('button', { name: 'Tłumaczenie i historia' }).click();
  await page.getByRole('button', { name: 'Przygotuj zakres i koszt' }).click();
  await expect(page.getByText(/Bieżąca quota: nieznana/)).toBeVisible();
  expect(confirms).toBe(0);
  await page
    .getByRole('button', { name: 'Potwierdź oddzielne zadanie' })
    .click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page
    .getByRole('button', { name: 'Potwierdź oddzielne zadanie' })
    .click();
  await expect(
    page.getByText(/Zadanie zapisano w trwałej kolejce/),
  ).toBeVisible();
  expect(intents[0]).toEqual(intents[1]);
  const recoverButtons = page.getByRole('button', {
    name: 'Przygotuj ponowienie brakujących segmentów',
  });
  await expect(recoverButtons.nth(1)).toBeDisabled();
  await recoverButtons.nth(0).click();
  await expect(
    page.getByText(/Zakres: brakujące segmenty źródła/),
  ).toBeVisible();
  expect(confirms).toBe(2);
  await page
    .getByRole('button', { name: 'Potwierdź oddzielne zadanie' })
    .click();
  expect(intents[2]).toMatchObject({ preview_hash: 'e'.repeat(64) });
  await page.getByRole('button', { name: /Czytaj polski helper/ }).click();
  const result = page.getByRole('article', {
    name: 'Wynik zadania opcjonalnego',
  });
  await expect(
    result.getByText('<img src=x onerror=alert(1)> Nie używano.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    result.getByText('Czas nieznany', { exact: true }),
  ).toBeVisible();
  expect(await result.locator('img').count()).toBe(0);
  await page
    .getByRole('button', { name: /Czytaj porównanie historii/ })
    .click();
  await expect(
    result.getByText('Bieżąca wypowiedź.', { exact: true }),
  ).toBeVisible();
  await expect(
    result.getByText('Poprzednia wypowiedź.', { exact: true }),
  ).toBeVisible();
  await expect(
    result.getByText(/interpretacja analizy: nieporównywalne/),
  ).toBeVisible();
  await expect(
    result.getByRole('button', { name: 'Źródło 1', exact: true }),
  ).toHaveCount(2);
  await result
    .getByRole('button', { name: 'Źródło 1', exact: true })
    .nth(1)
    .click();
  const drawer = page.getByRole('dialog', { name: 'Fragment źródła' });
  await expect(drawer.getByRole('alert')).toBeVisible();
  await drawer.getByRole('button', { name: 'Zamknij fragment źródła' }).click();
  await page.setViewportSize({ width: 360, height: 900 });
  expect(reprocessReads).toBe(0);
  await page
    .getByRole('button', { name: 'Ponowna analiza', exact: true })
    .click();
  await page.getByLabel('Profil i wersja').selectOption('custom:1');
  await page.getByLabel('Rodzaj zadania').selectOption('VALIDATE');
  await expect(
    page.getByRole('button', {
      name: 'Potwierdź dodatkowe zadanie',
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Przygotuj podgląd ponownej analizy' })
    .click();
  await page
    .getByRole('button', { name: 'Potwierdź dodatkowe zadanie', exact: true })
    .click();
  const reprocess = page.getByRole('region', {
    name: 'Ponowna analiza',
    exact: true,
  });
  await expect(reprocess.getByRole('alert')).toBeVisible();
  await page
    .getByRole('button', { name: 'Potwierdź dodatkowe zadanie', exact: true })
    .click();
  expect(reprocessIntents[1]).toEqual(reprocessIntents[0]);
  await expect(reprocess.getByRole('status')).toContainText(
    'wybór nowego wyniku wymaga osobnej decyzji',
  );
  await page.getByLabel('Reprezentacja źródła').selectOption('corrected-run');
  await expect(page.getByLabel('Rodzaj zadania')).toHaveValue('REPROCESS');
  await expect(
    page.getByRole('option', { name: 'Walidacja kandydata Custom' }),
  ).toHaveJSProperty('disabled', true);
  await expect(
    reprocess.getByText(/cytaty będą odnosiły się do poprawionej wersji/),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Przygotuj podgląd ponownej analizy' })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Potwierdź dodatkowe zadanie',
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel('Reprezentacja źródła').selectOption('source-run');
  await expect(
    page.getByRole('button', {
      name: 'Potwierdź dodatkowe zadanie',
      exact: true,
    }),
  ).toHaveCount(0);
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
