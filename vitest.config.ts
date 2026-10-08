import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { readFileSync } from 'node:fs';

const migrationQueries = await readD1Migrations('./db/migrations');
const ledger = JSON.parse(readFileSync('db/migration-ledger.json', 'utf8'));
const coreMigrations = ledger.migrations.map(
  (row: { name: string; sha256: string; depends_on: string[] }) => ({
    ...row,
    sql: readFileSync(`db/migrations/${row.name}`, 'utf8'),
    queries: migrationQueries.find((migration) => migration.name === row.name)!
      .queries,
  }),
);

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
            miniflare: { bindings: { CORE_MIGRATIONS: coreMigrations } },
          }),
        ],
        test: {
          name: 'workers',
          include: [
            'tests/workers/**/*.spec.ts',
            'tests/failure/**/*.spec.ts',
            'tests/security/**/*.spec.ts',
          ],
        },
      },
    ],
  },
});
