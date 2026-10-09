import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
test('reading verifies paged canonical bytes, preserves accepted text on failure and renders source attribution', async ({
  page,
}) => {
  const origin = 'https://reading.fixture.invalid',
    digest = (value: Buffer) =>
      createHash('sha256').update(value).digest('hex');
  let corrupt = false,
    corrected = false,
    disabled = false,
    full = false,
    badLink = false,
    playerLoads = 0,
    corrections = 0;
  await page.context().addCookies([
    {
      name: '__Host-bi-csrf',
      value: 'fixture-csrf',
      url: origin + '/',
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  const original = '<img src=x onerror=alert(1)> Not adopted.',
    second = 'Still evaluating.\nNo commitment.',
    sourceHash = digest(Buffer.from(original + ' GAP ' + second));
  const evidence = [
    {
      evidence_id: 'evidence-a',
      source_artifact_id: 'source',
      source_hash: sourceHash,
      segment_ids: ['segment-a'],
      quote_original: original,
      quote_pl: null,
      start_ms: 1234,
      end_ms: 2500,
      timestamp_precision: 'CUE',
      timestamp_url: 'https://www.youtube.com/watch?v=rUhllpnYWR8&t=1s',
      quote_hash: digest(Buffer.from(original)),
    },
    {
      evidence_id: 'evidence-b',
      source_artifact_id: 'source',
      source_hash: sourceHash,
      segment_ids: ['segment-b'],
      quote_original: second,
      quote_pl: null,
      start_ms: null,
      end_ms: null,
      timestamp_precision: 'NONE',
      timestamp_url: null,
      quote_hash: digest(Buffer.from(second)),
    },
  ];
  const requests: number[] = [];
  const canonical = () => ({
    schema_version: '1.2',
    item_id: 'item-reading',
    source_artifact_id: 'source',
    profile_id: 'ECONOMY',
    profile_revision: '1',
    status: 'OK',
    source_issues: [],
    enabled_modules: full
      ? ['claims', 'usage', 'contradictions']
      : disabled
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
        evidence_ids: ['evidence-a', 'evidence-b'],
      },
    ],
    stance: [],
    predictions: [],
    usage: full
      ? [
          {
            observation_id: 'usage-b',
            kind: 'USAGE',
            content_pl: 'Później wypróbowano narzędzie.',
            attribution: 'REPORTED_OTHER',
            qualifiers: ['cudzy projekt'],
            usage_stage: 'TRIED',
            prediction_horizon: null,
            stance_polarity: null,
            evidence_ids: ['evidence-b'],
            relation_refs: [],
          },
        ]
      : [],
    recommendations: [],
    uncertainties: [],
    contradictions: full
      ? [
          {
            observation_id: 'relation-a',
            kind: 'CONTRADICTION',
            content_pl: 'Możliwe napięcie między wypowiedziami.',
            attribution: 'UNCLEAR',
            epistemic_status: 'SOURCE_INFERENCE',
            qualifiers: [],
            prediction_horizon: null,
            stance_polarity: null,
            usage_stage: null,
            evidence_ids: ['evidence-a', 'evidence-b'],
            relation_refs: ['claim-a', 'usage-b'],
          },
        ]
      : [],
    evidence,
  });
  await page.route('https://www.youtube-nocookie.com/**', async (route) => {
    playerLoads++;
    expect(new URL(route.request().url()).searchParams.has('autoplay')).toBe(
      false,
    );
    await route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Fixture player</title>',
    });
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
    if (url.pathname === '/api/v1/corrections/source') {
      expect(route.request().method()).toBe('POST');
      expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
      expect(route.request().postDataJSON()).toMatchObject({
        patches: [
          {
            source_start: 0,
            source_end: 4,
            old_value: '<img',
            new_value: 'Literal',
          },
        ],
        reason: 'Owner checked spelling',
      });
      corrections++;
      return route.fulfill({ json: { job_id: 'source-correction-job' } });
    }
    expect(route.request().method()).toBe('GET');
    if (url.pathname.endsWith('/auth/session'))
      return route.fulfill({ json: { authenticated: true } });
    if (url.pathname.startsWith('/api/v1/evidence/')) {
      const value = evidence.find((value) =>
        url.pathname.endsWith('/' + value.evidence_id),
      )!;
      const start =
        value.evidence_id === 'evidence-a' ? 0 : original.length + 5;
      return route.fulfill({
        json: {
          ...value,
          quote_original:
            Buffer.byteLength(JSON.stringify(canonical())) > 32768
              ? null
              : value.quote_original,
          run_id: 'run-reading',
          item_id: 'item-reading',
          source_start: start,
          source_end: start + value.quote_original.length,
          offset_unit: 'UTF16_CODE_UNIT',
          source_url: badLink
            ? 'javascript:alert(1)'
            : 'https://www.youtube.com/watch?v=rUhllpnYWR8',
          provenance: {
            provider_id: 'fixture',
            ...(corrected ? { source_role: 'CORRECTED_SOURCE' } : {}),
          },
          helper_available: false,
          quote_transport:
            Buffer.byteLength(JSON.stringify(canonical())) > 32768
              ? 'PAGED_CANONICAL'
              : 'INLINE_CANONICAL',
          canonical_reference: {
            artifact_id: 'canonical',
            content_hash: digest(Buffer.from(JSON.stringify(canonical()))),
            first_page:
              '/api/v1/items/item-reading/canonical?run_id=run-reading&start=0',
          },
        },
      });
    }
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
          view: full
            ? {
                relational_coverage: 'WITHIN_CHUNKS_ONLY',
                coverage_complete: false,
              }
            : null,
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
      '/items/item-reading?return=%2Fdaily%2F2026-10-05%3Fdensity%3Dcompact#observation-claim-a',
  );
  await expect(
    page.getByRole('heading', { name: 'Źródłowa analiza narzędzia' }),
  ).toBeVisible();
  await expect(page.getByText(/^Zaakceptowana notatka/)).toBeVisible();
  await expect(
    page.getByText('Film oczekuje na zweryfikowany zapis', { exact: false }),
  ).toBeVisible();
  expect(requests).toEqual([0, 4]);
  await expect(page.locator('#observation-claim-a')).toBeFocused();
  await page.getByRole('button', { name: 'Źródło 1', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByText(original, { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Zamknij fragment źródła' }).click();
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
  const firstChip = page.getByRole('button', { name: 'Źródło 1', exact: true });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await firstChip.click();
  const drawer = page.getByRole('dialog', { name: 'Fragment źródła' });
  await expect(drawer.getByText(original, { exact: true })).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await expect(
    drawer.getByText(/Polski helper nie jest dostępny/),
  ).toBeVisible();
  await expect(
    drawer.getByRole('link', { name: 'Otwórz fragment w źródle' }),
  ).toHaveAttribute('href', evidence[0]!.timestamp_url!);
  expect(playerLoads).toBe(0);
  await drawer.getByRole('button', { name: 'Korekta zapisu źródła' }).click();
  await drawer.getByLabel('Fragment oryginalnego cytatu').fill('<img');
  await drawer.getByLabel('Poprawiony zapis').fill('Literal');
  await drawer
    .getByLabel('Powód poprawienia zapisu')
    .fill('Owner checked spelling');
  await drawer
    .getByRole('button', { name: 'Podgląd poprawienia źródła' })
    .click();
  expect(corrections).toBe(0);
  await drawer
    .getByRole('button', { name: 'Potwierdź poprawienie źródła' })
    .click();
  await expect(drawer.getByRole('status')).toContainText(
    'source-correction-job',
  );
  expect(corrections).toBe(1);
  await expect(drawer.locator('blockquote')).toHaveText(original);
  await drawer
    .getByRole('button', { name: 'Zamknij poprawianie źródła' })
    .click();
  await page.keyboard.press('Shift+Tab');
  expect(
    await drawer.evaluate((node) => node.contains(document.activeElement)),
  ).toBe(true);
  await drawer.getByRole('button', { name: 'Wczytaj odtwarzacz' }).click();
  await expect(drawer.locator('iframe')).toHaveCount(1);
  await drawer.getByRole('button', { name: 'Zamknij fragment źródła' }).focus();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(firstChip).toBeFocused();
  await page.getByRole('button', { name: 'Źródło 2', exact: true }).click();
  await expect(drawer.getByText(second, { exact: true })).toBeVisible();
  await expect(
    drawer.getByRole('link', { name: 'Otwórz film — czas nieznany' }),
  ).toHaveAttribute('href', 'https://www.youtube.com/watch?v=rUhllpnYWR8');
  await expect(
    drawer.getByText('Czas nieznany', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: '.local/gui/cp-4.6-evidence-mobile.png',
    fullPage: false,
  });
  await drawer.getByRole('button', { name: 'Zamknij fragment źródła' }).click();
  badLink = true;
  await firstChip.click();
  await expect(drawer.getByRole('alert')).toBeVisible();
  await expect(drawer.locator('a')).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Zamknij fragment źródła' }).click();
  corrupt = true;
  const currentUrl = new URL(page.url());
  currentUrl.searchParams.set(
    'return',
    '/ledger?kind=CLAIM&source_id=source-a',
  );
  await page.goto(currentUrl.href);
  await expect(
    page.getByRole('link', { name: '← Powrót do wiedzy' }),
  ).toHaveAttribute('href', '/ledger?kind=CLAIM&source_id=source-a');
  await page.reload();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('Wypowiedź źródła', { exact: true })).toHaveCount(
    0,
  );
  corrupt = false;
  badLink = false;
  full = true;
  await page.reload();
  await expect(
    page.getByText('Możliwa sprzeczność — interpretacja analizy', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/Zakres relacji jest częściowy/)).toBeVisible();
  await expect(page.getByText('Etap użycia: wypróbowano')).toBeVisible();
  const sides = page.getByRole('group', {
    name: 'Wypowiedzi porównywane w relacji',
  });
  await expect(
    sides.getByRole('link', { name: 'Pierwsza wypowiedź' }),
  ).toHaveAttribute('href', '#observation-claim-a');
  await expect(
    sides.getByRole('link', { name: 'Druga wypowiedź' }),
  ).toHaveAttribute('href', '#observation-usage-b');
  await sides.getByRole('link', { name: 'Druga wypowiedź' }).click();
  await expect(page.locator('#observation-usage-b')).toBeFocused();
  corrected = true;
  for (const [at, quote] of [
    [0, original],
    [1, second],
  ] as const) {
    await sides
      .getByRole('button', { name: 'Źródło 1', exact: true })
      .nth(at)
      .click();
    await expect(drawer.getByText(quote, { exact: true })).toBeVisible();
    await expect(
      drawer.getByText('Skorygowany zapis źródła · poprawka właściciela'),
    ).toBeVisible();
    await drawer
      .getByRole('button', { name: 'Zamknij fragment źródła' })
      .click();
  }
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
