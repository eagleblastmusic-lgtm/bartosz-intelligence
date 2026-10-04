import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.spec.ts'] } },
      {
        test: { name: 'contracts', include: ['tests/contracts/**/*.spec.ts'] },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './apps/api/wrangler.jsonc' },
          }),
        ],
        test: { name: 'workers', include: ['tests/workers/**/*.spec.ts'] },
      },
    ],
  },
});
