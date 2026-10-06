import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { uxFixtureSql, uxSessionSecret } from './ux-fixture.js';
import { sqliteAdapter } from '../db/sqlite-adapter.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { SearchIndex } from '../../packages/core/src/knowledge/search-index.js';
import { KnowledgeSearch } from '../../packages/core/src/knowledge/search.js';
import type {
  Database,
  Statement,
} from '../../packages/core/src/db/boundary.js';
import application from '../../config/application.json';

// Entirely isolated synthetic corpus. No Gemini, external data or production writes.
const root = resolve('.local/search-gate-' + randomUUID());
mkdirSync(root, { recursive: true });
const fixture = await uxFixtureSql(10000),
  sqlite = new DatabaseSync(':memory:');
let derived = '';
let plansSql = '';
try {
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(fixture.sql);
  const db = sqliteAdapter(sqlite),
    owner = await AccessContext.owner(
      db,
      await sha256(fixture.cookie.split('.')[0]!),
      new Date().toISOString(),
    ),
    index = new SearchIndex(db, owner);
  for (let step = 0; step < 20000; step++)
    if (!(await index.step(new Date())).progressed) break;
  if ((await index.metadata()).freshness !== 'FRESH')
    throw new Error('SEARCH_SEED_INCOMPLETE');
  const value = (value: unknown) =>
    value === null
      ? 'NULL'
      : typeof value === 'number'
        ? String(value)
        : "'" + String(value).replaceAll("'", "''") + "'";
  const statements: { sql: string; values: (string | number | null)[] }[] = [];
  const measured: Database = {
    prepare(sql) {
      const capture = { sql, values: [] as (string | number | null)[] };
      statements.push(capture);
      const wrap = (statement: Statement): Statement => ({
        bind(...values) {
          capture.values = values;
          return wrap(statement.bind(...values));
        },
        first: statement.first.bind(statement),
        all: statement.all.bind(statement),
        run: statement.run.bind(statement),
      });
      return wrap(db.prepare(sql));
    },
    batch: db.batch.bind(db),
  };
  const result = await new KnowledgeSearch(measured, owner).page(
    'publikacja',
    {},
    20,
    uxSessionSecret,
    new Date(),
  );
  if (
    statements.length !== 5 ||
    result.documents.length !== 20 ||
    statements.some((statement) => /COUNT\s*\(/i.test(statement.sql))
  )
    throw new Error('SEARCH_QUERY_BOUND_FAILED');
  plansSql = statements
    .map((statement) => {
      let index = 0;
      const sql = statement.sql.replaceAll('?', () =>
        value(statement.values[index++]),
      );
      if (index !== statement.values.length)
        throw new Error('SEARCH_PLAN_BINDING_MISMATCH');
      return 'EXPLAIN QUERY PLAN ' + sql + ';';
    })
    .join('\n');
  for (const table of ['search_documents', 'search_index_state'])
    for (const row of sqlite
      .prepare('SELECT * FROM ' + table + ' ORDER BY rowid')
      .all())
      derived +=
        'INSERT INTO ' +
        table +
        '(' +
        Object.keys(row).join(',') +
        ') VALUES(' +
        Object.values(row).map(value).join(',') +
        ');\n';
} finally {
  sqlite.close();
}
const config = resolve(root, 'wrangler.json'),
  seed = resolve(root, 'seed.sql');
writeFileSync(seed, fixture.sql + '\n' + derived);
writeFileSync(
  config,
  JSON.stringify({
    name: 'bartosz-search-isolated',
    main: resolve('apps/api/src/index.ts'),
    compatibility_date: '2026-10-01',
    workers_dev: false,
    assets: {
      directory: resolve('apps/web/dist'),
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: ['/api', '/api/*', '/health'],
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'search-fixture',
        database_id: '00000000-0000-0000-0000-000000000003',
      },
    ],
    queues: {
      producers: [{ binding: 'BARTOSZ_QUEUE', queue: 'search-fixture' }],
    },
    vars: {
      GOOGLE_OIDC_CLIENT_ID: 'ux-fixture',
      GOOGLE_OIDC_CLIENT_SECRET: 'ux-fixture',
      GOOGLE_OIDC_OWNER_SUBJECT: 'ux-fixture-owner',
      SESSION_SIGNING_SECRET: uxSessionSecret,
      APP_ORIGIN: application.app_origin,
    },
    dev: { ip: '127.0.0.1', port: 8792 },
  }),
);
const cli = resolve('node_modules/wrangler/bin/wrangler.js'),
  environment = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
const run = (args: string[]) =>
  new Promise<void>((yes, no) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: environment,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', no);
    child.on('exit', (code) =>
      code === 0 ? yes() : no(new Error('SEARCH_LOCAL_CLI_FAILED')),
    );
  });
await run([
  'd1',
  'execute',
  'DB',
  '--local',
  '--config',
  config,
  '--persist-to',
  root + '/state',
  '--file',
  seed,
]);
const plansPath = resolve(root, 'plans.sql');
writeFileSync(plansPath, plansSql);
const plans = await new Promise<unknown[]>((yes, no) => {
  const child = spawn(
    process.execPath,
    [
      cli,
      'd1',
      'execute',
      'DB',
      '--local',
      '--config',
      config,
      '--persist-to',
      root + '/state',
      '--file',
      plansPath,
      '--json',
    ],
    {
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  let output = '';
  child.stdout.on('data', (part: Buffer) => {
    output += part.toString();
    if (output.length > 1000000) child.kill();
  });
  child.on('error', no);
  child.on('exit', (code) => {
    try {
      if (code !== 0) throw new Error();
      const results = JSON.parse(output) as { results: { detail: string }[] }[];
      yes(results.map((result) => result.results.map((row) => row.detail)));
    } catch {
      no(new Error('SEARCH_PLAN_READ_FAILED'));
    }
  });
});
const server = spawn(
  process.execPath,
  [cli, 'dev', '--local', '--config', config, '--persist-to', root + '/state'],
  { env: environment, windowsHide: true, stdio: 'ignore' },
);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const report: Record<string, unknown> = {
  version: 'gate-s-local:1',
  sampled_at: new Date().toISOString(),
  fixture: 'SYNTHETIC_ISOLATED_10000_ITEMS',
  runtime: 'actual local workerd/D1 and built GUI',
  production_d1: 'NOT_RUN',
  ai_requests: 0,
  status: 'INCONCLUSIVE',
  query_inspection: {
    engine: 'actual local D1 EXPLAIN of KnowledgeSearch SQL',
    queries: 5,
    page_rows: 20,
    no_count_per_query: true,
    plans,
    rows_read: null,
    rows_read_status: 'NOT_EXPOSED_BY_LOCAL_RUNTIME',
  },
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      ready = (await fetch('http://127.0.0.1:8792/health')).ok;
    } catch {}
    if (ready) break;
    await delay(100);
  }
  if (!ready) throw new Error('SEARCH_LOCAL_NOT_READY');
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 360, height: 800 },
    reducedMotion: 'reduce',
  });
  await context.addCookies([
    {
      name: '__Host-bi-session',
      value: fixture.cookie,
      url: application.app_origin,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const trace: { path: string; status: number; elapsed_ms: number }[] = [];
  report.requests = trace;
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin !== application.app_origin ||
      route.request().method() !== 'GET'
    )
      throw new Error('SEARCH_UNEXPECTED_NETWORK');
    const start = performance.now(),
      response = await fetch(
        'http://127.0.0.1:8792' + url.pathname + url.search,
        { headers: { Cookie: '__Host-bi-session=' + fixture.cookie } },
      ),
      body = Buffer.from(await response.arrayBuffer());
    await delay(25 + (body.length * 8) / 10000);
    trace.push({
      path: url.pathname,
      status: response.status,
      elapsed_ms: performance.now() - start,
    });
    await route.fulfill({
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'text/plain',
      body,
    });
  });
  const page = await context.newPage();
  await page.goto(application.app_origin + '/search?q=publikacja');
  await page
    .getByRole('link', { name: /Publikacja ux-/ })
    .first()
    .waitFor();
  if (
    await page
      .getByText('Indeks wymaga aktualizacji.', { exact: false })
      .count()
  )
    throw new Error('SEARCH_INDEX_STALE');
  const elapsed: number[] = [];
  for (const query of [
    'gospodarka',
    'technologia',
    'publikacja',
    'analiza',
    'gospodarka',
  ]) {
    const start = performance.now();
    await page.getByRole('searchbox', { name: 'Szukane słowa' }).fill(query);
    const pendingResponse = page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/search?') &&
        new URL(response.url()).searchParams.get('q') === query,
    );
    await page.getByRole('searchbox', { name: 'Szukane słowa' }).press('Enter');
    await pendingResponse;
    await page
      .getByRole('link', { name: /Publikacja ux-/ })
      .first()
      .waitFor();
    elapsed.push(performance.now() - start);
  }
  await page.getByRole('button', { name: 'Pokaż kolejne wyniki' }).click();
  await page.locator('article[data-search-result]').nth(20).waitFor();
  const violations = (await new AxeBuilder({ page }).analyze()).violations;
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  elapsed.sort((a, b) => a - b);
  const p95 = elapsed[Math.ceil(elapsed.length * 0.95) - 1]!;
  Object.assign(report, {
    search_render_ms: elapsed,
    p95_search_render_ms: p95,
    target_ms: 300,
    axe_violations: violations.map((v) => ({ id: v.id, impact: v.impact })),
    mobile_overflow: overflow,
    requests: trace,
    local_acceptance:
      p95 <= 300 &&
      !violations.length &&
      !overflow &&
      trace.every((t) => t.status === 200)
        ? 'PASS'
        : 'FAIL',
  });
  await page.screenshot({
    path: resolve(root, 'search-mobile.png'),
    fullPage: true,
  });
  if (report.local_acceptance !== 'PASS')
    throw new Error('SEARCH_LOCAL_ACCEPTANCE_FAILED');
} catch (error) {
  report.failure = error instanceof Error ? error.message : 'SEARCH_FAILED';
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
  writeFileSync(
    resolve(root, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      report: resolve(root, 'report.json'),
      local_acceptance: report.local_acceptance ?? 'FAIL',
      production_d1: 'NOT_RUN',
    }),
  );
}
