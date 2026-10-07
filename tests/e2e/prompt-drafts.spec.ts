import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('Prompt Studio edits a new draft, preserves original text and retries a lost response safely', async ({
  page,
}) => {
  const origin = 'https://prompts.fixture.invalid';
  const ids = [
    'ECONOMY_ANALYSIS_V1',
    'FULL_ANALYSIS_V1',
    'ADVANCED_ANALYSIS_V1',
    'HISTORICAL_COMPARE_V1',
    'FULL_TRANSLATION_V1',
    'JSON_REPAIR_V1',
  ];
  const versions: Record<string, unknown>[] = [
    {
      prompt_id: ids[0],
      version: 2,
      prompt_hash: 'a'.repeat(64),
      status: 'PUBLISHED',
      created_at: '2026-10-07T00:00:00Z',
      prompt_text: 'Base {{source_text}}',
      required_inputs: ['source_text'],
    },
  ];
  let writes = 0;
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
        json: ids.map((id) => ({
          prompt_id: id,
          wire_schema_id: 'wire:1.0',
          canonical_schema_id: 'canonical:1.2',
          versions: versions
            .filter((v) => v.prompt_id === id)
            .slice()
            .reverse(),
        })),
      });
    if (url.pathname === '/api/v1/prompts/drafts') {
      expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
      const input = route.request().postDataJSON();
      intents.push(input);
      writes++;
      expect(input).toMatchObject({
        prompt_id: ids[0],
        base_version: 2,
        expected_latest_version: 2,
        reason: 'Clarify instructions',
      });
      const draft = {
        ...versions[0],
        version: 3,
        status: 'DRAFT',
        prompt_hash: 'b'.repeat(64),
        prompt_text: input.text,
      };
      if (writes === 1) {
        versions.push(draft);
        return route.abort('failed');
      }
      return route.fulfill({ json: draft });
    }
    if (url.pathname.startsWith('/api/v1/prompts/'))
      return route.fulfill({
        json: versions.find(
          (v) => v.version === Number(url.pathname.split('/').at(-1)),
        ),
      });
    if (url.pathname.startsWith('/api/'))
      throw new Error('UNEXPECTED_STUDIO_API');
    const local = await fetch('http://127.0.0.1:8787' + url.pathname);
    return route.fulfill({
      status: local.status,
      contentType: local.headers.get('content-type') ?? 'text/plain',
      body: Buffer.from(await local.arrayBuffer()),
    });
  });
  await page.goto(origin + '/system/prompts');
  await expect(
    page.getByRole('heading', { name: 'Prompt Studio' }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Rodzina promptu').locator('option'),
  ).toHaveCount(6);
  const save = page.getByRole('button', { name: 'Zapisz nową wersję draftu' });
  await expect(save).toBeDisabled();
  const draft =
    'Base {{source_text}}\n<img src=x onerror=alert(1)> Owner instruction.';
  await page.getByLabel('Treść nowego draftu').fill(draft);
  await expect(save).toBeDisabled();
  await page.getByLabel('Powód zmiany').fill('Clarify instructions');
  await page.getByText('Porównaj z wersją bazową 2', { exact: true }).click();
  await expect(page.locator('pre').first()).toHaveText('Base {{source_text}}');
  await expect(page.locator('pre').last()).toHaveText(draft);
  await expect(page.locator('img')).toHaveCount(0);
  expect(writes).toBe(0);
  await save.click();
  await expect(page.getByRole('alert')).toBeVisible();
  await save.click();
  await expect(page.getByRole('status')).toContainText(
    'Zapisano nową wersję 3',
  );
  expect(intents[1]).toEqual(intents[0]);
  await expect(page.getByLabel('Wersja bazowa')).toHaveValue('3');
  await expect(page.getByLabel('Treść nowego draftu')).toHaveValue(draft);
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
  expect(versions[0]!.prompt_text).toBe('Base {{source_text}}');
});
