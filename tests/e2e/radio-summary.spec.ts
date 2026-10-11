import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';

const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const notes = [
  {
    text_pl:
      'Zespół zastąpił skanowanie tabel wyszukiwaniem po indeksie. Według autorów ich benchmark wykazał spadek odczytów z 12 tysięcy do 40.',
    evidence_ids: ['evidence-first'],
  },
  {
    text_pl:
      'Ponowienia zachowują identyfikator operacji i sprawdzają pełny odczyt kontrolny. Wynik dotyczy badanego zbioru; przed zwiększeniem równoległości autorzy zalecają test odtwarzania po awarii.',
    evidence_ids: ['evidence-late'],
  },
];
const paragraph = notes.map((row) => row.text_pl).join(' ');
async function assets(route: import('@playwright/test').Route) {
  const response = await fetch(
    'http://127.0.0.1:8787' + new URL(route.request().url()).pathname,
  );
  await route.fulfill({
    status: response.status,
    contentType: response.headers.get('content-type') ?? 'text/plain',
    body: Buffer.from(await response.arrayBuffer()),
  });
}
test('Daily keeps one complete paragraph per film with metadata outside it in both densities', async ({
  page,
}) => {
  const origin = 'https://radio-daily.fixture.invalid';
  await page.route(origin + '/**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return assets(route);
    expect(route.request().method()).toBe('GET');
    if (url.pathname.endsWith('/auth/session'))
      return route.fulfill({ json: { authenticated: true } });
    if (url.pathname.endsWith('/sources'))
      return route.fulfill({ json: { sources: [], next_cursor: null } });
    expect(url.pathname).toBe('/api/v1/daily');
    await route.fulfill({
      json: {
        date: '2026-10-11',
        timezone: 'Europe/Warsaw',
        cut_seq: 2,
        projection_revision: '2',
        counts: {
          items: 2,
          ready: 2,
          pending: 0,
          blocked: 0,
          failed: 0,
          delivered: 2,
        },
        discovery_complete: true,
        complete: true,
        partial: false,
        next_cursor: null,
        source_coverage: [],
        freshness: { sampled_at: '2026-10-11T12:00:00Z', status: 'CURRENT' },
        items: [0, 1].map((i) => ({
          item_id: 'radio-' + i,
          title: 'Materiał ' + i,
          creator: 'Zespół testowy',
          published_at: '2026-10-11T10:00:00Z',
          analysis_status: 'READY',
          view: { summary_pl: notes },
          delivery: {
            state: 'VERIFIED',
            file_id: 'daily-fixture',
            remote_version: '1',
            verified_at: '2026-10-11T12:00:00Z',
          },
        })),
      },
    });
  });
  await page.goto(origin + '/daily/2026-10-11');
  for (const density of ['comfortable', 'compact']) {
    await page.getByLabel('Gęstość listy').selectOption(density);
    await expect(page.locator('p.summary-narrative')).toHaveCount(2);
    await expect(page.locator('p.summary-narrative').first()).toHaveText(
      paragraph,
    );
    expect(await page.locator('p.summary-narrative').allTextContents()).toEqual(
      [paragraph, paragraph],
    );
    await expect(
      page.locator(
        '.summary-narrative a, .summary-narrative ul, .summary-narrative h2',
      ),
    ).toHaveCount(0);
  }
  await page.screenshot({
    path: '.local/gui/radio-daily-desktop.png',
    fullPage: true,
  });
});

test('item narration is primary; evidence is collapsed, keyboard accessible and opens for a deep link', async ({
  page,
}) => {
  const origin = 'https://radio-item.fixture.invalid';
  const canonical = {
    schema_version: '1.2',
    item_id: 'radio-item',
    source_artifact_id: 'source',
    profile_id: 'ECONOMY',
    profile_revision: '1',
    status: 'OK',
    source_issues: [],
    enabled_modules: ['summary', 'key_points', 'claims'],
    summary_pl: notes,
    key_points: [
      {
        text_pl: 'Ograniczenie benchmarku do badanego zbioru.',
        evidence_ids: ['evidence-late'],
      },
    ],
    entities: [],
    tools: [],
    stance: [],
    predictions: [],
    usage: [],
    recommendations: [],
    uncertainties: [],
    contradictions: [],
    claims: [
      {
        observation_id: 'radio-claim',
        kind: 'CLAIM',
        content_pl: 'Autorzy raportują 40 odczytów w benchmarku.',
        attribution: 'SOURCE_SPEAKER',
        epistemic_status: 'SOURCE_EXPLICIT',
        qualifiers: ['tylko benchmark'],
        evidence_ids: ['evidence-first'],
        relation_refs: [],
      },
    ],
    evidence: notes.map((note, i) => ({
      evidence_id: note.evidence_ids[0],
      source_artifact_id: 'source',
      source_hash: digest(Buffer.from('fixture source')),
      segment_ids: ['segment-' + i],
      quote_original: i
        ? 'Test recovery before increasing concurrency.'
        : 'Reads fell from 12000 to 40 in our benchmark.',
      quote_pl: null,
      start_ms: i * 60000,
      end_ms: i * 60000 + 9000,
      timestamp_url: `https://www.youtube.com/watch?v=abcdefghijk&t=${i * 60}s`,
      timestamp_precision: 'CUE',
    })),
  };
  const bytes = Buffer.from(JSON.stringify(canonical));
  const descriptor = {
    artifact_id: 'canonical-radio',
    content_hash: digest(bytes),
    byte_size: bytes.length,
    chunk_count: 1,
    schema_version: 'intelligence-canonical:1.2',
  };
  await page.route(origin + '/**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return assets(route);
    expect(route.request().method()).toBe('GET');
    if (url.pathname.endsWith('/auth/session'))
      return route.fulfill({ json: { authenticated: true } });
    if (url.pathname.endsWith('/detail'))
      return route.fulfill({
        json: {
          item_id: 'radio-item',
          title: 'Jak ograniczać odczyty',
          creator: 'Zespół testowy',
          canonical_url: 'https://www.youtube.com/watch?v=abcdefghijk',
          published_at: '2026-10-11T10:00:00Z',
          analysis_status: 'READY',
          selected_run_id: 'run-radio',
          canonical: descriptor,
        },
      });
    expect(url.pathname).toBe('/api/v1/items/radio-item/canonical');
    return route.fulfill({
      json: {
        descriptor,
        chunks: [
          {
            chunk_index: 0,
            byte_start: 0,
            byte_size: bytes.length,
            byte_hash: digest(bytes),
            body_base64: bytes.toString('base64url'),
          },
        ],
        next_index: null,
      },
    });
  });
  await page.goto(origin + '/items/radio-item');
  await expect(page.locator('.summary-narrative')).toHaveText(paragraph);
  const details = page.locator('details').filter({
    has: page.locator('summary', { hasText: 'Źródła i szczegóły analizy' }),
  });
  await expect(details).not.toHaveAttribute('open', '');
  await expect(
    page.getByRole('heading', { name: 'Twierdzenia', exact: true }),
  ).toBeHidden();
  const toggle = details.locator('summary').first();
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(
    page.getByRole('heading', { name: 'Twierdzenia', exact: true }),
  ).toBeVisible();
  await expect(
    details.getByText(notes[1]!.text_pl, { exact: true }),
  ).toBeVisible();
  await expect(
    details.getByRole('button', { name: 'Źródło 1', exact: true }),
  ).toHaveCount(4);
  await toggle.click();
  await page.evaluate(() => {
    location.hash = 'observation-radio-claim';
  });
  await expect(page.locator('#observation-radio-claim')).toBeFocused();
  await expect(details).toHaveAttribute('open', '');
  await page.setViewportSize({ width: 360, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: '.local/gui/radio-item-mobile.png',
    fullPage: true,
  });
});
