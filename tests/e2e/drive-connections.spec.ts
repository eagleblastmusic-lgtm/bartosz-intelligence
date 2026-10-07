import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { DriveStatus } from '../../packages/contracts/src/drive.js';

test('Drive settings disclose unavailable export, preserve escaped private mapping and clear data on session loss', async ({
  page,
}) => {
  const origin = 'https://drive-ui.fixture.invalid';
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
  let authenticated = true,
    statusCalls = 0;
  const status: DriveStatus = {
    configured: false,
    export_capability: 'NOT_YET_VERIFIED',
    truncated: false,
    connections: [
      {
        connection_id: 'private-drive',
        auth_state: 'REAUTH_REQUIRED',
        root_id: '<img src=x> prywatny-folder',
        root_state: 'VERIFY_REQUIRED',
        publishing_state: 'UNKNOWN',
        revision: 1,
        last_refresh_at: null,
        last_error: 'PRIVATE_CREDENTIAL_RECOVERY_REQUIRED',
        scopes: ['https://www.googleapis.com/auth/drive.file'],
        offline_credential_present: false,
      },
    ],
  };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/auth/session')
      return route.fulfill({
        status: authenticated ? 200 : 401,
        json: authenticated
          ? { authenticated: true }
          : { code: 'UNAUTHENTICATED' },
      });
    if (path === '/api/v1/connections/drive/status') {
      statusCalls++;
      return route.fulfill({
        status: authenticated ? 200 : 401,
        json: authenticated ? status : { code: 'UNAUTHENTICATED' },
      });
    }
    throw new Error('UNEXPECTED_DRIVE_SETTINGS_REQUEST');
  });
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto(origin + '/system/connections');
  await expect(
    page.getByRole('heading', { name: 'Połączenia', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Połącz konto Google Drive',
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Połącz ponownie', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText('<img src=x> prywatny-folder', { exact: true }),
  ).toBeVisible();
  expect(await page.locator('main img').count()).toBe(0);
  await expect(
    page.getByText('Eksport do Drive oczekuje', { exact: false }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const refresh = page.getByRole('button', {
    name: 'Odśwież stan',
    exact: true,
  });
  await refresh.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => statusCalls).toBe(2);
  authenticated = false;
  await refresh.click();
  await expect(
    page.getByRole('link', { name: 'Zaloguj się przez Google', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('<img src=x> prywatny-folder', { exact: true }),
  ).toHaveCount(0);
});
