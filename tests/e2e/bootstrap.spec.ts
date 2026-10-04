import { test, expect } from '@playwright/test';
test('same-origin Assets shell, health, API boundary', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Bartosz Intelligence' }),
  ).toBeVisible();
  await page.goto('/unimplemented-route');
  await expect(
    page.getByRole('heading', { name: 'Bartosz Intelligence' }),
  ).toBeVisible();
  const health = await request.get('/health');
  expect(health.status()).toBe(200);
  expect((await health.json()).status).toBe('LOCAL_READY');
  const missing = await request.get('/api/not-implemented', {
    headers: { Accept: 'text/html' },
  });
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-type']).toContain('application/json');
});
