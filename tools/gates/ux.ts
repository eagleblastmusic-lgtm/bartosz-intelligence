import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { uxFixtureSql, uxSessionSecret } from './ux-fixture.js';
import { uxQueryPlans } from './ux-query-plan.js';
import application from '../../config/application.json';
import { createServer } from 'node:http';

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
if (arg('--scope') !== 'v1a' || arg('--items') !== '10000')
  throw new Error('UX_SCOPE_REQUIRED');
const output = resolve(arg('--output') || '.local/gate-u-v1a');
const root = resolve('.local/ux-' + randomUUID());
mkdirSync(root, { recursive: true });
mkdirSync(output, { recursive: true });
const config = resolve(root, 'wrangler.json');
writeFileSync(
  config,
  JSON.stringify({
    name: 'bartosz-ux-isolated',
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
        database_name: 'ux-fixture',
        database_id: '00000000-0000-0000-0000-000000000002',
      },
    ],
    queues: { producers: [{ binding: 'BARTOSZ_QUEUE', queue: 'ux-fixture' }] },
    vars: {
      GOOGLE_OIDC_CLIENT_ID: 'ux-fixture',
      GOOGLE_OIDC_CLIENT_SECRET: 'ux-fixture',
      GOOGLE_OIDC_OWNER_SUBJECT: 'ux-fixture-owner',
      SESSION_SIGNING_SECRET: uxSessionSecret,
      APP_ORIGIN: application.app_origin,
    },
    dev: { ip: '127.0.0.1', port: 8789 },
  }),
);
const fixture = await uxFixtureSql(10000);
const sqlPath = resolve(root, 'seed.sql');
writeFileSync(sqlPath, fixture.sql);
const cli = resolve('node_modules/wrangler/bin/wrangler.js');
const run = (args: string[]) =>
  new Promise<void>((yes, no) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', no);
    child.on('exit', (code) =>
      code === 0 ? yes() : no(new Error('UX_LOCAL_CLI_FAILED')),
    );
  });
const counters = () =>
  new Promise<Record<string, number>>((yes, no) => {
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
        '--json',
        '--command',
        'SELECT (SELECT COUNT(*) FROM usage_records) usage_records,(SELECT COUNT(*) FROM jobs) jobs,(SELECT COUNT(*) FROM change_log) change_events',
      ],
      {
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    let captured = '';
    child.stdout.on('data', (chunk: Buffer) => {
      captured += chunk.toString();
      if (captured.length > 65536) child.kill();
    });
    child.on('error', no);
    child.on('exit', (code) => {
      try {
        if (code !== 0) throw new Error('UX_COUNTER_READ_FAILED');
        yes(JSON.parse(captured)[0].results[0]);
      } catch {
        no(new Error('UX_COUNTER_READ_FAILED'));
      }
    });
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
  sqlPath,
]);
const beforeCounters = await counters();
const server = spawn(
  process.execPath,
  [cli, 'dev', '--local', '--config', config, '--persist-to', root + '/state'],
  {
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    windowsHide: true,
    stdio: 'ignore',
  },
);
const delays = (ms: number) => new Promise((r) => setTimeout(r, ms));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const report: Record<string, unknown> = {
  version: 'gate-u:1',
  sampled_at: new Date().toISOString(),
  fixture: 'SYNTHETIC_ISOLATED_10000',
  fixture_id: fixture.fixture_id,
  implementation:
    'actual built GUI and local Worker/D1, real owner-session middleware; no API fixtures',
  network: {
    latency_ms: 25,
    download_mbps: 10,
    method: 'explicit proxy response delay plus byte delivery budget',
    server: 'local workerd/D1',
    device: 'local headless Chromium, DPR 1, no CPU throttle',
  },
  manual_screen_reader: 'NOT_RUN',
  manual_keyboard: 'NOT_RUN',
  status: 'INCONCLUSIVE',
  build_files: [
    'apps/web/dist/index.html',
    ...readdirSync('apps/web/dist/assets').map(
      (name) => 'apps/web/dist/assets/' + name,
    ),
  ].map((path) => ({
    path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  })),
  query_inspection: await uxQueryPlans(
    fixture.sql,
    fixture.cookie,
    uxSessionSecret,
  ),
};
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready = (await fetch('http://127.0.0.1:8789/health')).ok;
    } catch {}
    if (ready) break;
    await delays(100);
  }
  if (!ready) throw new Error('UX_SERVER_NOT_READY');
  browser = await chromium.launch();
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const origin = application.app_origin;
  await page.context().addCookies([
    {
      name: '__Host-bi-session',
      value: fixture.cookie,
      url: origin,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const traces: {
    path: string;
    status: number;
    bytes: number;
    elapsed_ms: number;
  }[] = [];
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin)
      throw new Error('UX_UNEXPECTED_EXTERNAL_REQUEST');
    if (route.request().method() !== 'GET')
      throw new Error('UX_UNEXPECTED_MUTATION');
    const start = performance.now();
    const response = await fetch(
      'http://127.0.0.1:8789' + url.pathname + url.search,
      { headers: { Cookie: '__Host-bi-session=' + fixture.cookie } },
    );
    const body = Buffer.from(await response.arrayBuffer());
    await delays(25 + (body.length * 8) / 10000);
    traces.push({
      path: url.pathname,
      status: response.status,
      bytes: body.length,
      elapsed_ms: performance.now() - start,
    });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(
        [...response.headers].filter(
          ([name]) =>
            ![
              'content-encoding',
              'content-length',
              'transfer-encoding',
            ].includes(name),
        ),
      ),
      body,
    });
  });
  const first = performance.now();
  report.phase = 'FIRST_VIEW';
  await page.goto(origin + '/daily/2026-10-05');
  await page.locator('.daily-row').first().waitFor();
  const firstUseful = performance.now() - first;
  if ((await page.locator('.daily-row').count()) !== 20)
    throw new Error('UX_PAGE_UNBOUNDED');
  const counts = await page.locator('.count-line').textContent();
  if (!counts?.includes('10000')) throw new Error('UX_CORPUS_NOT_10000');
  const trials: number[] = [];
  report.phase = 'FILTERS';
  for (let i = 0; i < 20; i++) {
    const checkbox = page.getByRole('checkbox').first(),
      start = performance.now();
    await checkbox.click();
    await page
      .locator('.count-line')
      .filter({ hasText: i % 2 === 0 ? '5000' : '10000' })
      .waitFor();
    trials.push(performance.now() - start);
  }
  const sorted = trials.slice().sort((a, b) => a - b),
    p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
  report.performance = {
    first_useful_ms: firstUseful,
    filter_trials_ms: trials,
    filter_p95_ms: p95,
    first_threshold_ms: 2000,
    filter_threshold_ms: 300,
    status: firstUseful <= 2000 && p95 <= 300 ? 'PASS' : 'FAIL',
    cache: 'first navigation cold browser, repeated filters warm runtime',
  };
  const matrix: unknown[] = [];
  report.phase = 'MATRIX';
  for (const theme of ['light', 'dark'])
    for (const width of [360, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByLabel('Motyw', { exact: true }).selectOption(theme);
      const audit = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      const reflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      );
      await page.screenshot({
        path: resolve(output, `daily-${theme}-${width}.png`),
        fullPage: false,
      });
      matrix.push({
        theme,
        width,
        reflow,
        violations: audit.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.map((n) => n.target),
        })),
      });
    }
  report.matrix = matrix;
  const additional: unknown[] = [];
  for (const route of ['channels', 'system']) {
    await page.goto(origin + '/' + route);
    await page
      .getByRole('heading', {
        name: route === 'channels' ? 'Kanały' : 'System',
        exact: true,
      })
      .waitFor();
    if (route === 'system')
      await page.getByText('Gate C:', { exact: false }).waitFor();
    for (const theme of ['light', 'dark'])
      for (const width of [360, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.getByLabel('Motyw', { exact: true }).selectOption(theme);
        const audit = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze();
        additional.push({
          route,
          theme,
          width,
          reflow: await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          violations: audit.violations.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => n.target),
          })),
        });
      }
  }
  report.additional_surfaces = additional;
  await page.goto(origin + '/daily/2026-10-05');
  await page.locator('.daily-row').first().waitFor();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole('button', { name: 'Kalendarz', exact: true }).click();
  await page.locator('[data-date="2026-10-05"]').waitFor();
  const calendar = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  const calendarTargets = await page
    .locator('.calendar button')
    .evaluateAll((nodes) =>
      nodes.map((el) => ({
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height,
      })),
    );
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  const focusRestored = await page
    .getByRole('button', { name: 'Kalendarz', exact: true })
    .evaluate((el) => el === document.activeElement);
  report.calendar = {
    violations: calendar.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
    focus_restored: focusRestored,
    important_targets_44px: calendarTargets.every(
      (target) => target.width >= 44 && target.height >= 44,
    ),
  };
  await page.setViewportSize({ width: 180, height: 400 });
  report.zoom_200_reflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
  report.zoom_overflow_elements = await page.evaluate(() =>
    [...document.querySelectorAll('main *,header *,nav *')]
      .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
      .map((el) => ({
        tag: el.tagName,
        class: el.className,
        width: el.getBoundingClientRect().width,
      }))
      .slice(0, 20),
  );
  await page.screenshot({
    path: resolve(output, 'zoom-200.png'),
    fullPage: false,
  });
  report.read_traces = traces;
  report.ai_requests = 0;
  report.automated_status =
    (report.performance as { status: string }).status === 'PASS' &&
    matrix.every((row) => {
      const r = row as { reflow: boolean; violations: unknown[] };
      return r.reflow && !r.violations.length;
    }) &&
    additional.every((row) => {
      const r = row as { reflow: boolean; violations: unknown[] };
      return r.reflow && !r.violations.length;
    }) &&
    !calendar.violations.length &&
    focusRestored &&
    calendarTargets.every(
      (target) => target.width >= 44 && target.height >= 44,
    ) &&
    report.zoom_200_reflow
      ? 'PASS'
      : 'FAIL';
} catch (error) {
  report.automated_status = 'FAIL';
  report.error_type = error instanceof Error ? error.name : 'UNKNOWN';
  if (report.phase === 'MATRIX' && error instanceof Error)
    report.audit_error = error.message
      .replace(/https?:\/\/[^\s)]+/g, '[URL]')
      .slice(0, 1200);
  report.reason =
    error instanceof Error && /^[A-Z_0-9]+$/.test(error.message)
      ? error.message
      : 'UX_HARNESS_FAILED';
} finally {
  await browser?.close();
  if (
    !process.argv.includes('--serve-review') ||
    report.automated_status !== 'PASS'
  )
    server.kill();
}
const afterCounters = await counters();
report.backend_counters = {
  before: beforeCounters,
  after: afterCounters,
  unchanged: JSON.stringify(beforeCounters) === JSON.stringify(afterCounters),
};
if (JSON.stringify(beforeCounters) !== JSON.stringify(afterCounters))
  report.automated_status = 'FAIL';
writeFileSync(
  resolve(output, 'report.json'),
  JSON.stringify(report, null, 2) + '\n',
);
process.stdout.write(
  JSON.stringify({
    automated_status: report.automated_status,
    status: report.status,
    report: resolve(output, 'report.json'),
  }) + '\n',
);
if (report.automated_status !== 'PASS') process.exitCode = 1;
else if (process.argv.includes('--serve-review')) {
  const review = createServer(async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405);
      response.end('Read-only synthetic review environment');
      return;
    }
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1:8790');
      const upstream = await fetch(
        'http://127.0.0.1:8789' + url.pathname + url.search,
        { headers: { Cookie: '__Host-bi-session=' + fixture.cookie } },
      );
      response.writeHead(
        upstream.status,
        Object.fromEntries(
          [...upstream.headers].filter(
            ([name]) =>
              ![
                'content-encoding',
                'content-length',
                'transfer-encoding',
                'set-cookie',
              ].includes(name),
          ),
        ),
      );
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.writeHead(503);
      response.end('Review backend unavailable');
    }
  });
  review.listen(8790, '127.0.0.1', () =>
    process.stdout.write(
      'SYNTHETIC_READ_ONLY_REVIEW=http://127.0.0.1:8790/daily/2026-10-05\n',
    ),
  );
  review.on('error', () => {
    server.kill();
    process.exitCode = 1;
  });
  process.on('SIGINT', () => {
    review.close();
    server.kill();
  });
  process.on('SIGTERM', () => {
    review.close();
    server.kill();
  });
}
