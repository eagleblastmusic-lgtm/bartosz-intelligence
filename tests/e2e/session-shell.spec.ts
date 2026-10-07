import { expect, test, type Page } from '@playwright/test';
import type { DailySnapshot } from '../../packages/contracts/src/daily.js';
const empty: DailySnapshot = {
  date: '2026-10-05',
  timezone: 'Europe/Warsaw',
  cut_seq: 1,
  projection_revision: 'fixture',
  counts: { items: 0, ready: 0, pending: 0, blocked: 0, failed: 0 },
  discovery_complete: false,
  complete: false,
  partial: true,
  items: [],
  next_cursor: null,
  source_coverage: [],
  freshness: { sampled_at: '2026-10-06T12:00:00Z', status: 'CURRENT' },
};
async function fixture(page: Page) {
  const origin = 'https://shell.fixture.invalid';
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
  await page.context().addCookies([
    {
      name: '__Host-bi-csrf',
      value: 'fixture-csrf',
      url: origin + '/',
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  let authenticated = true;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/auth/session')
      return route.fulfill({
        status: authenticated ? 200 : 401,
        json: authenticated
          ? { authenticated: true }
          : { code: 'UNAUTHENTICATED' },
      });
    if (path === '/api/v1/auth/logout') {
      expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
      authenticated = false;
      return route.fulfill({ json: { authenticated: false } });
    }
    if (path === '/api/v1/sources')
      return route.fulfill({
        json: {
          sources: [
            {
              source_id: 'private-source',
              title: 'Prywatna nazwa kanału',
              enabled: 1,
              last_complete_window_end: null,
            },
          ],
          next_cursor: null,
        },
      });
    if (path === '/api/v1/jobs')
      return route.fulfill({ json: { jobs: [], next_cursor: null } });
    if (path === '/api/v1/daily') return route.fulfill({ json: empty });
    if (path === '/api/v1/system/summary')
      return route.fulfill({
        json: {
          sampled_at: '2026-10-06T12:00:00Z',
          paid_services_enabled: false,
          ai_profile: 'gemini_free',
          transcript_runtime: 'local',
          workers: [],
          durable_jobs: [],
          quota: [],
        },
      });
    throw new Error('UNEXPECTED_SHELL_API');
  });
  return origin;
}
test('deep links, history, focus and logout clear private views and preserve only the theme preference', async ({
  page,
}) => {
  const origin = await fixture(page);
  await page.goto(origin + '/channels');
  await expect(
    page.getByRole('heading', { name: 'Kanały', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', {
      name: 'Profil analizy: Prywatna nazwa kanału',
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'System', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'System', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#main-content')).toBeFocused();
  await expect(page.getByText(/Limit nieodczytany/)).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Kanały', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Motyw', { exact: true }).selectOption('dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Wyloguj', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Zaloguj się przez Google' }),
  ).toBeVisible();
  await expect(page.getByText(/Prywatna nazwa kanału/)).toHaveCount(0);
  const storage = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
  expect(storage).toEqual({ local: { 'bi-theme': 'dark' }, session: {} });
});
test('401 on a domain read clears the private shell and does not turn into a setup error', async ({
  page,
}) => {
  const origin = await fixture(page);
  await page.goto(origin + '/channels');
  await expect(
    page.getByRole('link', {
      name: 'Profil analizy: Prywatna nazwa kanału',
      exact: true,
    }),
  ).toBeVisible();
  await page.route('**/api/v1/system/summary', (route) =>
    route.fulfill({ status: 401, json: { code: 'UNAUTHENTICATED' } }),
  );
  await page.getByRole('link', { name: 'System', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Zaloguj się przez Google' }),
  ).toBeVisible();
  await expect(page.getByText(/Sesja wygasła/)).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByText(/Prywatna nazwa kanału/)).toHaveCount(0);
});
test('light and dark shell have measured AA token contrast, keyboard focus and narrow reflow', async ({
  page,
}) => {
  const origin = await fixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(origin + '/daily/2026-10-05');
  await expect(
    page.getByRole('heading', { name: 'Jeszcze nie ma publikacji' }),
  ).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.getByLabel('Motyw', { exact: true }).selectOption(theme);
    const contrast = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const lum = (name: string) => {
        const hex = style.getPropertyValue(name).trim().slice(1);
        const color =
          hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
        const rgb = [0, 2, 4]
          .map((at) => parseInt(color.slice(at, at + 2), 16) / 255)
          .map((v) =>
            v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
          );
        return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
      };
      const pairs = [
        ['--text', '--canvas', 4.5],
        ['--text', '--surface', 4.5],
        ['--muted', '--surface', 4.5],
        ['--muted', '--subtle', 4.5],
        ['--accent', '--surface', 4.5],
        ['--accent-text', '--accent', 4.5],
        ['--waiting', '--subtle', 4.5],
        ['--danger', '--subtle', 4.5],
        ['--focus', '--canvas', 3],
        ['--border', '--surface', 3],
      ] as const;
      return pairs.map(([fg, bg, minimum]) => {
        const a = lum(fg),
          b = lum(bg);
        return {
          fg,
          bg,
          minimum,
          ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        };
      });
    });
    for (const pair of contrast)
      expect(
        pair.ratio,
        `${theme} ${pair.fg}/${pair.bg}`,
      ).toBeGreaterThanOrEqual(pair.minimum);
    for (const width of [1440, 1024, 768, 360, 180]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(
        page.getByRole('link', { name: 'Kanały', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Wyloguj', exact: true }),
      ).toBeVisible();
      if (width === 1440 || width === 360)
        await page.screenshot({
          path: `.local/gui/cp-4.2-${theme}-${width}.png`,
          fullPage: true,
        });
    }
    await page.getByRole('link', { name: 'Kanały', exact: true }).focus();
    const focus = await page
      .getByRole('link', { name: 'Kanały', exact: true })
      .evaluate((el) => getComputedStyle(el).outlineWidth);
    expect(parseFloat(focus)).toBeGreaterThanOrEqual(3);
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { name: 'Kanały', exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(
      page.getByRole('heading', { name: 'Jeszcze nie ma publikacji' }),
    ).toBeVisible();
  }
});
