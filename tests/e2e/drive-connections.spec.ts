import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type {
  DriveStatus,
  DailyExportStatus,
} from '../../packages/contracts/src/drive.js';

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
  let createCalls = 0;
  let disconnectCalls = 0;
  const exports: DailyExportStatus = {
    automatic_updates_qualified: false,
    truncated: false,
    days: [
      {
        root_id: 'export-root',
        date: '2026-10-05',
        connection_id: 'private-drive',
        desired_mode: 'COMPACT',
        remote_mode: 'COMPACT',
        settings_revision: 1,
        desired_generation: 0,
        exported_generation: 0,
        dirty_seq: 3,
        exported_seq: 1,
        remote_revision: 1,
        file_id: 'same-file',
        rendered_revision: 2,
        rendered_cut: 3,
        rendered_bytes: 2048,
        auth_state: 'REAUTH_REQUIRED',
        root_state: 'VERIFIED',
        last_verified_at: null,
        retry_reason: 'DRIVE_UNQUALIFIED_UPDATE',
        retry_count: 8,
        paused_reason: 'RETRY_BUDGET_EXHAUSTED',
        queue_state: 'AUTH_REQUIRED',
        due_at: null,
      },
    ],
  };
  const status: DriveStatus = {
    root_candidates: [
      {
        connection_id: 'private-drive',
        name: 'Existing folder',
        folder_id: 'saved-root',
        state: 'CREATED',
      },
    ],
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
    if (path === '/api/v1/connections/drive/disconnect') {
      expect(route.request().postDataJSON()).toEqual({
        connection_id: 'private-drive',
        expected_revision: 7,
      });
      disconnectCalls++;
      status.connections[0]!.auth_state = 'REVOKED';
      status.connections[0]!.offline_credential_present = false;
      status.connections[0]!.revision = 8;
      return route.fulfill({ json: { auth_state: 'REVOKED' } });
    }
    if (path === '/api/v1/connections/drive/exports/status')
      return route.fulfill({
        status: authenticated ? 200 : 401,
        json: authenticated ? exports : { code: 'UNAUTHENTICATED' },
      });
    if (path === '/api/v1/connections/drive/exports/mode') {
      expect(route.request().postDataJSON()).toEqual({
        root_id: 'export-root',
        date: '2026-10-05',
        mode: 'FULL',
        expected_revision: 1,
      });
      exports.days[0]!.desired_mode = 'FULL';
      exports.days[0]!.settings_revision = 2;
      return route.fulfill({
        json: { desired_mode: 'FULL', settings_revision: 2 },
      });
    }
    if (path === '/api/v1/connections/drive/exports/retry') {
      expect(route.request().postDataJSON()).toEqual({
        root_id: 'export-root',
        date: '2026-10-05',
        expected_revision: 2,
      });
      exports.days[0]!.retry_count = 0;
      exports.days[0]!.paused_reason = null;
      exports.days[0]!.settings_revision = 3;
      return route.fulfill({ json: { settings_revision: 3 } });
    }
    if (path === '/api/v1/connections/drive/exports/conflict/preview') {
      expect(route.request().postDataJSON()).toEqual({
        connection_id: 'private-drive',
        root_id: 'export-root',
        date: '2026-10-05',
        expected_connection_revision: 6,
        expected_settings_revision: 3,
      });
      status.connections[0]!.revision = 7;
      return route.fulfill({
        json: {
          connection_id: 'private-drive',
          connection_revision: 7,
          preview_hash: 'c'.repeat(64),
          file_id: 'same-file',
          remote_version: '9',
          remote_hash: 'd'.repeat(64),
          remote_bytes: 1234,
          expires_at: '2026-10-08T15:00:00Z',
        },
      });
    }
    if (path === '/api/v1/connections/drive/exports/conflict/confirm') {
      expect(route.request().postDataJSON()).toEqual({
        connection_id: 'private-drive',
        expected_connection_revision: 7,
        preview_hash: 'c'.repeat(64),
        action: 'KEEP_MANUAL',
      });
      exports.days[0]!.paused_reason = 'OWNER_PRESERVED_MANUAL';
      return route.fulfill({ json: { remote_write_performed: false } });
    }
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
    if (path === '/api/v1/connections/drive/root/preview') {
      expect(route.request().postDataJSON()).toEqual({
        connection_id: 'private-drive',
        root_id: 'selected-folder',
        expected_revision: 1,
      });
      status.connections[0]!.revision = 2;
      return route.fulfill({
        json: {
          folder_name: '<img src=x> folder preview',
          root_changed: true,
          existing_mapping_count: 7,
          storage: { usage_bytes: '123', limit_bytes: null },
          export_ready: false,
          folder_metadata_access: 'PASS',
          child_create_read_update: 'NOT_RUN',
        },
      });
    }
    if (path === '/api/v1/connections/drive/root/create') {
      createCalls++;
      if (createCalls === 1) {
        expect(route.request().postDataJSON().expected_revision).toBe(2);
        status.connections[0]!.revision = 3;
        return route.fulfill({
          status: 409,
          json: { code: 'REVISION_CONFLICT' },
        });
      }
      expect(route.request().postDataJSON()).toEqual({
        connection_id: 'private-drive',
        name: 'Daily',
        expected_revision: 3,
      });
      status.connections[0]!.revision = 4;
      return route.fulfill({
        json: {
          requested_root_id: 'created-private-root',
          current_root_id: status.connections[0]!.root_id,
          folder_name: 'Daily',
          root_changed: true,
          existing_mapping_count: 7,
          storage: { usage_bytes: '123', limit_bytes: null },
          export_ready: false,
          folder_metadata_access: 'PASS',
          private_owner_only: true,
          created_candidate: true,
          connection_revision: 4,
          preview_hash: 'a'.repeat(64),
          guard_receipt_hash: 'b'.repeat(64),
          child_create_read_update: 'PASS',
        },
      });
    }
    if (path === '/api/v1/connections/drive/root/confirm') {
      expect(route.request().postDataJSON()).toEqual({
        connection_id: 'private-drive',
        preview_hash: 'a'.repeat(64),
        expected_revision: 4,
        acknowledge_mapping_review: true,
      });
      status.connections[0]!.root_id = 'created-private-root';
      status.connections[0]!.root_state = 'VERIFIED';
      status.connections[0]!.revision = 6;
      return route.fulfill({
        json: { root_state: 'VERIFIED', export_ready: false },
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
  await page
    .getByLabel('Docelowy tryb dla 2026-10-05', { exact: true })
    .selectOption('FULL');
  await expect(
    page.getByLabel('Docelowy tryb dla 2026-10-05', { exact: true }),
  ).toHaveValue('FULL');
  await expect(page.getByText('same-file', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Tryb zapisany w Drive: COMPACT.', { exact: false }),
  ).toBeVisible();
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
  status.configured = true;
  status.connections[0]!.auth_state = 'CONNECTED';
  status.connections[0]!.offline_credential_present = true;
  await refresh.click();
  await expect(
    page.getByRole('button', { name: 'Sprawdź folder', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Użyj folderu Existing folder', exact: true })
    .click();
  await expect(
    page.getByLabel('Identyfikator wybranego folderu', { exact: true }),
  ).toHaveValue('saved-root');
  await expect(
    page.getByLabel('Nazwa nowego prywatnego folderu', { exact: true }),
  ).toHaveValue('Existing folder');
  await page
    .getByLabel('Nazwa nowego prywatnego folderu', { exact: true })
    .fill('Daily');
  await page
    .getByLabel('Identyfikator wybranego folderu', { exact: true })
    .fill('selected-folder');
  await page
    .getByRole('button', { name: 'Sprawdź folder', exact: true })
    .click();
  await expect(
    page.getByText(
      'Folder: <img src=x> folder preview. Odczyt metadanych: potwierdzony.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Próba zapisu, odczytu i aktualizacji pliku dziecka: nie wykonano. Eksport: niedostępny.',
      { exact: true },
    ),
  ).toBeVisible();
  expect(await page.locator('main img').count()).toBe(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByRole('button', { name: 'Utwórz prywatny folder', exact: true })
    .click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Stan połączenia zmienił się' }),
  ).toBeVisible();
  await expect.poll(() => statusCalls).toBeGreaterThanOrEqual(5);
  expect(createCalls).toBe(1);
  await page
    .getByRole('button', { name: 'Utwórz prywatny folder', exact: true })
    .click();
  await expect(
    page.getByText('Uprawnienia: wyłącznie właściciel.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Identyfikator wybranego folderu', { exact: true }),
  ).toHaveValue('created-private-root');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const confirm = page.getByRole('button', {
    name: 'Zatwierdź folder Daily',
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await page
    .getByRole('checkbox', {
      name: 'Potwierdzam przegląd istniejących mapowań.',
      exact: false,
    })
    .check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(
    page.getByText('created-private-root', { exact: true }),
  ).toBeVisible();
  exports.days[0]!.auth_state = 'CONNECTED';
  await page
    .getByRole('button', { name: 'Odśwież eksporty', exact: true })
    .click();
  const retry = page.getByRole('button', {
    name: 'Ponów eksport 2026-10-05',
    exact: true,
  });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(retry).toHaveCount(0);
  status.connections[0]!.root_id = 'export-root';
  exports.days[0]!.paused_reason = 'EXPORT_CONFLICT';
  exports.days[0]!.queue_state = 'PAUSED';
  await page
    .getByRole('button', { name: 'Odśwież eksporty', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Sprawdź konflikt 2026-10-05', exact: true })
    .click();
  await expect(
    page.getByRole('link', {
      name: 'Otwórz ręczną wersję w Drive',
      exact: true,
    }),
  ).toHaveAttribute('href', 'https://drive.google.com/file/d/same-file/view');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByRole('button', {
      name: 'Zachowaj ręczną wersję i wstrzymaj eksport 2026-10-05',
      exact: true,
    })
    .click();
  await expect(
    page.getByText('Właściciel zachował ręczną wersję.', { exact: false }),
  ).toBeVisible();
  await expect(retry).toHaveCount(0);
  await refresh.click();
  await page.getByRole('button', { name: 'Odłącz Drive', exact: true }).click();
  expect(disconnectCalls).toBe(0);
  await page.getByRole('button', { name: 'Anuluj', exact: true }).click();
  expect(disconnectCalls).toBe(0);
  await page.getByRole('button', { name: 'Odłącz Drive', exact: true }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByRole('button', { name: 'Potwierdź odłączenie', exact: true })
    .click();
  await expect(page.getByText('Odłączono', { exact: true })).toBeVisible();
  expect(disconnectCalls).toBe(1);
  await expect(page.getByText('export-root', { exact: true })).toHaveCount(2);
  authenticated = false;
  await refresh.click();
  await expect(
    page.getByRole('link', { name: 'Zaloguj się przez Google', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('<img src=x> prywatny-folder', { exact: true }),
  ).toHaveCount(0);
});
