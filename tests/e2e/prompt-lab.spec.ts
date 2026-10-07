import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('Lab prepares controlled pairs without AI, explicitly submits with retry, preserves history and reviews cancellation/budget', async ({
  page,
}) => {
  const origin = 'https://prompt-lab.fixture.invalid',
    family = 'ECONOMY_ANALYSIS_V1',
    hash = 'a'.repeat(64);
  let submitted = 0,
    prepared = 0,
    cancelled = false,
    budgetSaves = 0;
  const intents: unknown[] = [];
  const reviewIntents: unknown[] = [];
  let humanReviews: unknown[] = [];
  const experiment = {
    experiment_hash: hash,
    version: 'prompt-lab:1',
    controls: {
      mode: 'PROMPT_AB',
      variants: [{ model: 'gemini-3.8-flash' }, { model: 'gemini-3.8-flash' }],
    },
    reason: 'Compare clarity',
    cases: [
      {
        variant: 'A',
        repeat: 1,
        source_hash: 'b'.repeat(64),
        kind: 'ANALYSIS',
        preview_hash: 'c'.repeat(64),
      },
      {
        variant: 'B',
        repeat: 1,
        source_hash: 'b'.repeat(64),
        kind: 'ANALYSIS',
        preview_hash: 'd'.repeat(64),
      },
    ],
  };
  await page.context().addCookies([
    {
      name: '__Host-bi-csrf',
      value: 'fixture-csrf',
      url: origin,
      secure: true,
    },
  ]);
  await page.route(origin + '/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (request.method() === 'POST')
      expect(request.headers()['x-csrf-token']).toBe('fixture-csrf');
    if (path === '/api/v1/auth/session')
      return route.fulfill({ json: { authenticated: true } });
    if (path === '/api/v1/prompts')
      return route.fulfill({
        json: [
          {
            prompt_id: family,
            versions: [
              { version: 3, status: 'DRAFT' },
              { version: 2, status: 'PUBLISHED' },
            ],
            active: { version: 2, generation: 1, new_use_allowed: true },
          },
        ],
      });
    if (
      path === '/api/v1/prompts/' + family + '/2' ||
      path === '/api/v1/prompts/' + family + '/3'
    )
      return route.fulfill({
        json: {
          prompt_id: family,
          version: Number(path.split('/').at(-1)),
          status: 'DRAFT',
          prompt_hash: hash,
          prompt_text: 'Source {{source_text}}',
          required_inputs: ['source_text'],
        },
      });
    if (path.endsWith('/tests')) return route.fulfill({ json: [] });
    if (path === '/api/v1/items')
      return route.fulfill({
        json: {
          items: [
            { item_id: 'item-1', metadata: { title: 'Synthetic Lab source' } },
          ],
          next_cursor: null,
        },
      });
    if (path === '/api/v1/reprocess/context/item-1')
      return route.fulfill({
        json: {
          available: true,
          source_choices: [
            {
              run_id: 'source-original',
              role: 'SOURCE_ORIGINAL',
              label: 'Original',
            },
          ],
          profiles: [
            {
              profile_id: 'monitor',
              revision: 1,
              name: 'Monitoring',
              mode: 'ECONOMY',
              optional_tasks: false,
            },
          ],
          model_profile: {
            profile_id: 'gemini_free',
            revision: 1,
            model: 'gemini-3.8-flash',
          },
          settings: {
            runtime: 'local',
            mode: 'QUALITY_TEST',
            purpose: 'professional_single_owner',
            region: 'PL',
            max_output_tokens: 2000,
            limits: {},
          },
        },
      });
    if (path === '/api/v1/prompts/lab/prepare') {
      prepared++;
      const input = request.postDataJSON();
      expect(input).toMatchObject({
        prompt_id: family,
        version: 3,
        comparison_version: 2,
        source_run_id: 'source-original',
        semantic_profile_id: 'monitor',
        semantic_profile_revision: 1,
        model_revision: 1,
        repeats: 1,
        reason: 'Compare clarity',
      });
      return route.fulfill({ json: experiment });
    }
    if (path === '/api/v1/prompts/lab/experiments')
      return route.fulfill({
        json: {
          items: [
            {
              experiment_hash: hash,
              created_at: '2026-10-07T10:00:00Z',
              reason: 'Compare clarity',
              source_count: 1,
              case_count: 2,
            },
          ],
          next_before: null,
        },
      });
    if (path === '/api/v1/prompts/lab/experiments/' + hash)
      return route.fulfill({
        json: {
          experiment_hash: hash,
          definition: experiment,
          cancelled,
          jobs: submitted
            ? [
                {
                  job_id: 'lab-job',
                  state: 'SUCCEEDED',
                  case_index: 0,
                  run_id: 'lab-run',
                  candidate_hash: hash,
                  validation_outcome: 'DETERMINISTIC_CORE_CANDIDATE',
                  run_state: 'CANDIDATE',
                },
              ]
            : [],
          history_truncated: false,
        },
      });
    if (path.endsWith('/submit')) {
      submitted++;
      intents.push(request.postDataJSON());
      if (submitted === 1) return route.abort('failed');
      return route.fulfill({
        json: { job_id: 'lab-job', already_queued: true },
      });
    }
    if (path.endsWith('/inspect')) {
      const source = url.searchParams.get('section') === 'SOURCE';
      return route.fulfill({
        json: {
          run_id: 'lab-run',
          candidate_hash: hash,
          section: source ? 'SOURCE' : 'CANONICAL',
          format: source ? 'ORIGINAL_TEXT' : 'JSON',
          content_hash: hash,
          text: source
            ? 'I did not use Tool X at 12%.'
            : '{"text":"<img src=x onerror=alert(1)>"}',
          offset: 0,
          end: 40,
          total_code_units: 40,
          next_offset: null,
          reason_code: 'QUALITY_TEST_COMPLETE',
        },
      });
    }
    if (path.endsWith('/reviews')) {
      if (request.method() === 'GET')
        return route.fulfill({
          json: {
            reviews: humanReviews,
            truncated: false,
            quality_approval: 'NOT_GRANTED',
          },
        });
      const input = request.postDataJSON();
      reviewIntents.push(input);
      expect(input).toMatchObject({
        expected_revision: 0,
        review: {
          reviewer_id: 'FIXTURE_A',
          role: 'PRIMARY',
          blind_label: 'sample-17',
          scores: [null, null, null, null],
          supported: null,
          important_claims_complete: null,
          evidence_valid: null,
          critical_errors: null,
          notes: 'Synthetic review persistence check',
        },
      });
      humanReviews = [{ revision: 1, hash, review: input.review }];
      if (reviewIntents.length === 1) return route.abort('failed');
      return route.fulfill({
        json: { revision: 1, hash, quality_approval: 'NOT_GRANTED' },
      });
    }
    if (path.endsWith('/cancel')) {
      expect(request.postDataJSON()).toEqual({
        reason: 'Stop synthetic trials',
      });
      cancelled = true;
      return route.fulfill({
        json: {
          experiment_hash: hash,
          definition: experiment,
          cancelled: true,
          jobs: [],
          history_truncated: false,
        },
      });
    }
    if (path === '/api/v1/prompts/lab/quota') {
      if (request.method() === 'GET')
        return route.fulfill({ contentType: 'application/json', body: 'null' });
      budgetSaves++;
      expect(request.postDataJSON()).toMatchObject({
        account_key: 'fixture-project',
        model: 'gemini-3.8-flash',
        daily_requests: 1,
        normal_headroom: { RPM: 1, RPD: 2, INPUT_TPM: 100 },
        expected_revision: 0,
        reason: 'Protect normal processing',
      });
      return route.fulfill({
        json: { revision: 1, policy: { daily_requests: 1 } },
      });
    }
    if (path.startsWith('/api/'))
      throw new Error('UNEXPECTED_TEST_API: ' + path);
    const response = await fetch('http://127.0.0.1:8787' + path);
    return route.fulfill({
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'text/plain',
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  await page.goto(origin + '/system/prompts');
  await page.getByLabel('Wersja bazowa').selectOption('3');
  const title = 'Porównaj dwie wersje w Prompt Lab';
  await page.getByText(title, { exact: true }).click();
  const form = page.getByText(title, { exact: true }).locator('..');
  await form.getByLabel('Materiał do próby').selectOption('item-1');
  await form
    .getByRole('combobox', { name: 'Profil semantyczny', exact: true })
    .selectOption('monitor:1');
  await form.getByLabel('Wersja promptu B').fill('2');
  await form.getByLabel('Cel porównania').fill('Compare clarity');
  expect(prepared).toBe(0);
  expect(submitted).toBe(0);
  await form.getByRole('button', { name: 'Przygotuj porównanie A/B' }).click();
  const comparison = form.getByRole('region', {
    name: 'Eksperyment Prompt Lab',
  });
  await expect(comparison).toContainText('Ten sam model');
  expect(prepared).toBe(1);
  expect(submitted).toBe(0);
  await comparison.getByRole('button', { name: 'Uruchom próbę A/1' }).click();
  await expect(comparison.getByRole('alert')).toBeVisible();
  await comparison.getByRole('button', { name: 'Uruchom próbę A/1' }).click();
  await expect(comparison.getByRole('status')).toContainText('lab-job');
  expect(intents[0]).toEqual(intents[1]);
  await comparison
    .getByText('Wynik, źródło i oceny · lab-run', { exact: true })
    .click();
  const review = comparison
    .getByText('Wynik, źródło i oceny · lab-run', { exact: true })
    .locator('..');
  await expect(review.locator('pre')).toContainText(
    '<img src=x onerror=alert(1)>',
  );
  expect(await page.locator('img').count()).toBe(0);
  await review.getByRole('button', { name: 'Pokaż przypięte źródło' }).click();
  await expect(review.locator('pre')).toContainText(
    'I did not use Tool X at 12%.',
  );
  await review.getByLabel('Identyfikator oceniającego').fill('FIXTURE_A');
  await review.getByLabel('Etykieta próbki ze ślepej oceny').fill('sample-17');
  await review
    .getByLabel('Uwagi oceniającego')
    .fill('Synthetic review persistence check');
  await review.getByRole('button', { name: 'Przejrzyj zapis oceny' }).click();
  expect(reviewIntents).toHaveLength(0);
  await review
    .getByRole('button', { name: 'Potwierdź zapis ręcznej oceny' })
    .click();
  await expect(review.getByRole('alert')).toBeVisible();
  await review
    .getByRole('button', { name: 'Potwierdź zapis ręcznej oceny' })
    .click();
  await expect(review.getByRole('status')).toContainText(
    'Zapisano rewizję oceny 1',
  );
  expect(reviewIntents[0]).toEqual(reviewIntents[1]);
  await expect(review).toContainText(
    'Nie oceniono / Nie oceniono / Nie oceniono / Nie oceniono',
  );
  await comparison
    .getByLabel('Powód anulowania eksperymentu')
    .fill('Stop synthetic trials');
  await comparison
    .getByRole('button', { name: 'Przejrzyj anulowanie' })
    .click();
  expect(cancelled).toBe(false);
  await comparison
    .getByRole('button', { name: 'Potwierdź anulowanie eksperymentu' })
    .click();
  await expect(comparison).toContainText('dalsze requesty są zablokowane');
  await expect(
    comparison.getByRole('button', { name: 'Uruchom próbę B/1' }),
  ).toBeDisabled();
  await page.getByText('Budżet Prompt Lab', { exact: true }).click();
  const budget = page
    .getByText('Budżet Prompt Lab', { exact: true })
    .locator('..');
  await budget
    .getByLabel('Identyfikator projektu Gemini')
    .fill('fixture-project');
  await budget.getByLabel('Model Gemini dla budżetu').fill('gemini-3.8-flash');
  await budget.getByLabel('Maksymalnie requestów Lab na dzień').fill('1');
  await budget.getByLabel('Zapas requestów na dzień').fill('2');
  await budget.getByLabel('Zapas tokenów wejścia na minutę').fill('100');
  await budget
    .getByLabel('Powód zmiany budżetu')
    .fill('Protect normal processing');
  await budget.getByRole('button', { name: 'Przejrzyj budżet Lab' }).click();
  expect(budgetSaves).toBe(0);
  await budget.getByRole('button', { name: 'Potwierdź budżet Lab' }).click();
  await expect(budget.getByRole('status')).toContainText('Zapisano budżet Lab');
  await page
    .getByText('Historia eksperymentów Prompt Lab', { exact: true })
    .click();
  const history = page
    .getByText('Historia eksperymentów Prompt Lab', { exact: true })
    .locator('..');
  await history
    .getByRole('button', { name: 'Compare clarity · 1 źródeł · 2 prób' })
    .click();
  await expect(
    history.getByRole('region', { name: 'Eksperyment Prompt Lab' }),
  ).toContainText('dalsze requesty są zablokowane');
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
