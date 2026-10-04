import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:8787', headless: true },
  webServer: {
    command: 'pnpm dev:api',
    url: 'http://127.0.0.1:8787/health',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
