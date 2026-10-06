import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import type { RegistryBundle } from '../../packages/core/src/registry/bundle.js';
import { compileSemanticProfile } from '../../packages/core/src/ai/semantic-profile.js';
const bundle = JSON.parse(
  readFileSync('config/registry/master-bundle.json', 'utf8'),
) as RegistryBundle;

test('profile editor materializes exact Custom scope and retries a lost save without invoking AI', async ({
  page,
}) => {
  const origin = 'https://profiles.fixture.invalid';
  const rows: Record<string, unknown>[] = [];
  const writes: Record<string, unknown>[] = [];
  const assignments: Record<string, unknown>[] = [];
  await page.route(origin + '/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname.endsWith('/auth/session'))
        return route.fulfill({ json: { authenticated: true } });
      if (url.pathname === '/api/v1/profiles')
        return route.fulfill({ json: { profiles: rows, has_more: false } });
      if (
        url.pathname.endsWith('/assignments') &&
        route.request().method() === 'GET'
      )
        return route.fulfill({ json: { assignments: [], has_more: false } });
      const input = route.request().postDataJSON() as Record<string, unknown>;
      if (url.pathname.endsWith('/assignments')) {
        assignments.push(input);
        return route.fulfill({ json: { generation: 1 } });
      }
      if (url.pathname.endsWith('/preview'))
        return route.fulfill({
          json: await compileSemanticProfile(input.config, bundle),
        });
      if (url.pathname.endsWith('/versions')) {
        writes.push(input);
        if (writes.length === 1) return route.abort('failed');
        const compiled = await compileSemanticProfile(input.config, bundle);
        rows.push({
          profile_id: input.profile_id,
          revision: input.revision,
          name: input.name,
          config_json: JSON.stringify(compiled.config),
        });
        return route.fulfill({ json: { ...input, compiled } });
      }
      throw new Error('UNEXPECTED_PROFILE_API');
    }
    const local = await fetch('http://127.0.0.1:8787' + url.pathname);
    return route.fulfill({
      status: local.status,
      contentType: local.headers.get('content-type') ?? 'text/plain',
      body: Buffer.from(await local.arrayBuffer()),
    });
  });
  await page.goto(origin + '/system/profiles');
  await page.getByLabel('Tryb', { exact: true }).selectOption('CUSTOM');
  for (const name of [
    'Kluczowe punkty',
    'Encje',
    'Narzędzia',
    'Twierdzenia',
    'Stanowisko',
    'Przewidywania',
  ])
    await page.getByLabel(name, { exact: true }).uncheck();
  await page.getByLabel('Możliwe sprzeczności', { exact: true }).check();
  await page
    .getByLabel('Tłumaczenie', { exact: true })
    .selectOption('IMPORTANT_SEGMENTS');
  await page
    .getByLabel('Drugi przebieg źródła · osobne wywołanie', { exact: true })
    .check();
  await page
    .getByLabel('Cel drugiego przebiegu', { exact: true })
    .fill('Sprawdzenie kwalifikatorów źródła');
  await page
    .getByRole('button', { name: 'Sprawdź zakres', exact: true })
    .click();
  await expect(page.getByText(/Minimum 3 wywołań/)).toBeVisible();
  await page.getByText('Dokładny schemat i wersje', { exact: true }).click();
  await expect(page.locator('pre')).toContainText('"maxItems": 0');
  await expect(page.locator('pre')).not.toContainText('"claims":');
  await page
    .getByLabel('Powód nowej wersji', { exact: true })
    .fill('Jawny zakres właściciela');
  await page
    .getByRole('button', { name: 'Zapisz wersję', exact: true })
    .click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page
    .getByRole('button', { name: 'Zapisz wersję', exact: true })
    .click();
  await expect(page.getByRole('status')).toHaveText('Zapisano wersję 1.');
  expect(writes).toHaveLength(2);
  expect(writes[0]).toEqual(writes[1]);
  await page.setViewportSize({ width: 360, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Mój profil · v1' }).click();
  await expect(page.getByLabel('Tryb', { exact: true })).toHaveValue('CUSTOM');
  await expect(page.getByLabel('Tłumaczenie', { exact: true })).toHaveValue(
    'IMPORTANT_SEGMENTS',
  );
  await expect(
    page.getByRole('button', { name: 'Sprawdź przypisanie', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Nowy profil', exact: true }).click();
  await page
    .getByRole('button', { name: 'Sprawdź zakres', exact: true })
    .click();
  await page
    .getByLabel('Powód nowej wersji', { exact: true })
    .fill('Aktywny Economy');
  await page
    .getByRole('button', { name: 'Zapisz wersję', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Sprawdź przypisanie', exact: true })
    .click();
  const pending = page.getByLabel(
    'Zastosuj także do oczekujących materiałów bez przypiętej analizy',
    { exact: true },
  );
  await expect(pending).not.toBeChecked();
  await pending.check();
  await page
    .getByLabel('Powód przypisania', { exact: true })
    .fill('Jawna decyzja dla oczekujących');
  await page
    .getByRole('button', { name: 'Potwierdź przypisanie', exact: true })
    .click();
  await expect(page.getByRole('status')).toHaveText('Przypisano wersję 1.');
  expect(assignments).toHaveLength(1);
  expect(assignments[0]).toMatchObject({
    apply_to_pending: true,
    source_id: null,
    revision: 1,
    expected_generation: 0,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
