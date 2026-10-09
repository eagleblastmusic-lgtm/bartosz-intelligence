import { test, expect } from '@playwright/test';
import { unobservedCapacity } from '../../packages/core/src/projections/capacity.js';
import type { DailyExportStatus } from '../../packages/contracts/src/drive.js';

test('System preserves unknown capacity, stale quota, failed age and incomplete usage without invoking AI', async ({
  page,
}) => {
  const origin = 'https://system.fixture.invalid';
  const summary = {
    sampled_at: '2026-10-06T12:00:00Z',
    paid_services_enabled: false,
    ai_profile: 'gemini_free',
    pipeline_capabilities: [
      {
        profile_id: 'codex_subscription',
        adapter_available: false,
        state: 'DISABLED',
        execution_locations: [],
        quality_gate: '0B',
        gate_state: 'NOT_RUN',
        allowance_remaining: null,
      },
    ],
    transcript_runtime: 'local',
    daily_exports: undefined as DailyExportStatus | undefined,
    workers: [
      {
        worker_id: 'fixture',
        runtime: 'local',
        heartbeat_at: '2026-10-01T00:00:00Z',
        availability: 'OFFLINE',
      },
    ],
    durable_jobs: [
      {
        state: 'FAILED',
        count: 1,
        task_type: 'ANALYZE',
        origin_kind: 'NEW',
        oldest_arrival_origin_at: '2026-10-01T00:00:00Z',
      },
    ],
    quota: [
      {
        provider: 'gemini',
        bucket: 'RPD',
        remaining: 17,
        freshness: 'UNKNOWN',
        sampled_at: '2026-10-01T00:00:00Z',
        reset_at: null,
        source: 'AI_STUDIO',
      },
    ],
    capacity_metrics: unobservedCapacity('2026-10-06T12:00:00Z'),
    job_reasons: [
      {
        state: 'FAILED',
        count: 1,
        task_type: 'ANALYZE',
        origin_kind: 'NEW',
        reason_code: 'NO_CAPTIONS',
        oldest_arrival_origin_at: '2026-10-01T00:00:00Z',
        next_due_at: null,
        attempts: 4,
      },
    ],
    usage: {
      requests: 4,
      unknown_usage_count: 4,
      known_total_tokens: 0,
      known_input_tokens: 0,
      known_output_tokens: 0,
      latest_observed_at: null,
    },
  };
  let fail = false,
    reads = 0;
  await page.route(origin + '/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/')) {
      expect(route.request().method()).toBe('GET');
      if (path === '/api/v1/auth/session')
        return route.fulfill({ json: { authenticated: true } });
      if (path === '/api/v1/system/retention')
        return route.fulfill({
          json: {
            policy: 'DRIVE_ONLY_VERIFIED_PLUS_7_DAYS',
            settings: null,
            items: [],
          },
        });
      if (path === '/api/v1/system/summary') {
        reads++;
        return fail
          ? route.fulfill({ status: 503, json: { code: 'UNAVAILABLE' } })
          : route.fulfill({ json: summary });
      }
      throw new Error('UNEXPECTED_SYSTEM_API');
    }
    const local = await fetch('http://127.0.0.1:8787' + path);
    return route.fulfill({
      status: local.status,
      contentType: local.headers.get('content-type') ?? 'text/plain',
      body: Buffer.from(await local.arrayBuffer()),
    });
  });
  await page.goto(origin + '/system');
  const inactive = page.locator('section').filter({
    has: page.getByRole('heading', {
      name: 'Nieaktywne pipeline',
      exact: true,
    }),
  });
  await expect(inactive).toContainText('Codex Subscription');
  await expect(inactive).toContainText(
    'Wyłączony — brak adaptera i aktywacji.',
  );
  await expect(inactive).toContainText('Gate 0B: Nie wykonano');
  await expect(inactive).toContainText('Pozostały allowance: nieodczytano.');
  await expect(inactive.locator('[role="alert"]')).toHaveCount(0);
  await expect(page.getByText(/bieżąca wartość nieznana/)).toBeVisible();
  await expect(
    page.getByText('Gemini Free', { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(/Offline · ostatni heartbeat/)).toBeVisible();
  await expect(
    page.getByText(/Własne wywołania w Ledgerze: 4 · nieznane użycie: 4/),
  ).toBeVisible();
  await expect(page.getByText(/Znane tokeny:/)).toHaveCount(0);
  const capacity = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Pojemność i obserwacja' }),
  });
  await expect(capacity.locator('dt')).toHaveCount(8);
  await expect(capacity.locator('dd')).toHaveCount(8);
  for (const row of await capacity.locator('dd').all())
    await expect(row).toContainText('Nieznane');
  await expect(page.getByText(/Gate C: NOT_RUN/)).toBeVisible();
  await expect(page.getByText(/Stan eksportu nieodczytany/)).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Pipeline' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Ponów|Retry/ })).toHaveCount(
    0,
  );
  await page.setViewportSize({ width: 360, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '.local/gui/cp4.7-system-mobile.png',
    fullPage: true,
  });
  summary.capacity_metrics.metrics.estimated_drain_time.status = 'NOT_DRAINING';
  summary.daily_exports = {
    automatic_updates_qualified: false,
    truncated: true,
    days: [
      {
        root_id: 'root',
        date: '2026-10-05',
        connection_id: 'connection',
        desired_mode: 'FULL',
        remote_mode: 'COMPACT',
        settings_revision: 2,
        desired_generation: 1,
        exported_generation: 0,
        dirty_seq: 3,
        exported_seq: 1,
        remote_revision: 1,
        file_id: 'file',
        rendered_revision: 2,
        rendered_cut: 3,
        rendered_bytes: 2048,
        auth_state: 'CONNECTED',
        root_state: 'VERIFIED',
        last_verified_at: null,
        retry_reason: 'EXPORT_CONFLICT',
        queue_state: 'DUE',
        due_at: null,
      },
    ],
  };
  await page.getByRole('button', { name: 'Odśwież stan' }).click();
  await expect(page.getByText(/Zaległości nie maleją/)).toBeVisible();
  await expect(
    page.getByText(/Oczekujące zmiany w tym odczycie: 1. Konflikty: 1./),
  ).toBeVisible();
  await expect(page.getByText(/razem 2048 B/)).toBeVisible();
  await expect(page.getByText(/lista jest niekompletna/)).toBeVisible();
  await expect(page.getByText(/Briefing Bridge: NOT_RUN/)).toBeVisible();
  fail = true;
  await page.getByRole('button', { name: 'Odśwież stan' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(capacity.locator('dt')).toHaveCount(8);
  expect(reads).toBe(3);
});
