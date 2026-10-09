import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { queryBatch, remoteDatabase } from '../../deployment/cloudflare.mjs';
import { d1TestBudget } from '../../deployment/d1-test-budget.js';
import {
  d1UsagePolicy,
  type UsageSample,
} from '../../deployment/d1-usage-policy.js';
import { AccessContext } from '../../../packages/core/src/db/boundary.js';
import { sha256, randomToken } from '../../../packages/core/src/auth/crypto.js';
import { TranscriptRecovery } from '../../../packages/core/src/transcript/recovery.js';
import { CapacityCollection } from '../../../packages/core/src/projections/capacity-collection.js';
import { scheduleMetadataRefresh } from '../../../packages/core/src/sources/youtube/refresh.js';
import ledger from '../../../db/migration-ledger.json';

// One current SQL measurement per operation. No backup, AI, private content,
// temporary session writes or automatic retries after a measurement failure.
if (process.argv.slice(2).join(' ') !== '--live --once')
  throw new Error('EXPLICIT_BOUNDED_LIVE_MEASUREMENT_REQUIRED');
const now = new Date(),
  day = now.toISOString().slice(0, 10);
const probe = JSON.parse(
  readFileSync('docs/verification/release/d1-probe-' + day + '.json', 'utf8'),
);
if (probe.state !== 'AVAILABLE') throw new Error('ACTUAL_D1_PROBE_REQUIRED');
const sample = JSON.parse(
  readFileSync('.local/d1-usage/latest.json', 'utf8'),
) as UsageSample;
if (!d1UsagePolicy(sample, now).noncritical_admitted)
  throw new Error('D1_LIVE_MEASUREMENT_BUDGET_NOT_ADMITTED');
const transcriptCredential = process.env.LOCAL_WORKER_CREDENTIAL;
const telemetryCredential = process.env.LOCAL_TELEMETRY_WORKER_CREDENTIAL;
if (!transcriptCredential || !telemetryCredential)
  throw new Error('EXISTING_SCOPED_WORKER_CREDENTIALS_REQUIRED');
const intent = '.local/d1-resume/' + day + '-measure-intent.json';
if (existsSync(intent)) throw new Error('D1_MEASUREMENT_ALREADY_ATTEMPTED');
mkdirSync('.local/d1-resume', { recursive: true });
writeFileSync(
  intent,
  JSON.stringify({
    started_at: now.toISOString(),
    operations: 3,
    paid_services_enabled: false,
  }) + '\n',
  { flag: 'wx' },
);
const budget = d1TestBudget(queryBatch, {
  requests: 250,
  rows_read: 50000,
  rows_written: 5000,
});
const db = remoteDatabase(budget.execute);
const operations: Record<string, unknown>[] = [];
let status = 'NOT_COMPLETE';
try {
  const applied = await db
    .prepare(
      `SELECT name,sha256 FROM applied_migrations ORDER BY name LIMIT ${ledger.migrations.length + 1}`,
    )
    .all<{ name: string; sha256: string }>();
  if (
    JSON.stringify(applied.results) !==
    JSON.stringify(
      ledger.migrations.map(({ name, sha256 }) => ({ name, sha256 })),
    )
  )
    throw new Error('VERIFIED_CURRENT_MIGRATIONS_REQUIRED');
  const transcript = await AccessContext.worker(
    db,
    await sha256(transcriptCredential),
  );
  const telemetry = await AccessContext.worker(
    db,
    await sha256(telemetryCredential),
  );
  for (const [label, measure] of [
    [
      'transcript_admission',
      () =>
        new TranscriptRecovery(db, transcript).admission(new Date(), 'local'),
    ],
    [
      'capacity_page',
      () =>
        new CapacityCollection(db, telemetry).page(
          50,
          randomToken(),
          new Date(),
        ),
    ],
    ['metadata_refresh', () => scheduleMetadataRefresh(db, new Date())],
  ] as const) {
    const before = { ...budget.usage };
    await measure(); // Metadata refresh retains real due intent if due; never rolled back.
    operations.push({
      operation: label,
      requests: budget.usage.requests - before.requests,
      rows_read: budget.usage.rows_read - before.rows_read,
      rows_written: budget.usage.rows_written - before.rows_written,
    });
    if (budget.usage.stopped) throw new Error('D1_LIVE_MEASUREMENT_STOPPED');
  }
  status = 'MEASURED';
} catch (error) {
  const code = error instanceof Error ? error.message : '';
  operations.push({
    stopped_reason: /^(?:D1_|VERIFIED_MIGRATION_)[A-Z_0-9]+$/.test(code)
      ? code
      : 'MEASUREMENT_FAILED_REDACTED',
  });
  process.exitCode = 2;
} finally {
  const receipt = {
    version: 'D1LiveCostMeasurement/1.0',
    observed_at: new Date().toISOString(),
    status,
    basis: 'ACTUAL_PRODUCTION_REST_META',
    operations,
    usage: budget.usage,
    exact_remaining_quota: null,
    private_content_recorded: false,
    paid_services_enabled: false,
  };
  mkdirSync('docs/verification/release', { recursive: true });
  writeFileSync(
    'docs/verification/release/d1-live-cost-' + day + '.json',
    JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(JSON.stringify(receipt));
}
