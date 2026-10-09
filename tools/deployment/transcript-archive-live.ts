import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { queryBatch, remoteDatabase } from './cloudflare.mjs';
import { d1TestBudget } from './d1-test-budget.js';
import { d1UsagePolicy, type UsageSample } from './d1-usage-policy.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { DriveClient } from '../../packages/core/src/drive/client.js';
import { importDriveWrappingKey } from '../../packages/core/src/drive/credentials.js';
import { refreshDriveAccess } from '../../packages/core/src/drive/oauth.js';
import { provisionTranscriptFolder } from '../../packages/core/src/transcript/archive-folder.js';
import { TranscriptDriveArchive } from '../../packages/core/src/transcript/archive.js';
import defaults from '../../config/defaults.json';
import ledger from '../../db/migration-ledger.json';

const mode = process.argv[2];
if (
  process.argv.length !== 3 ||
  !['--provision-folder', '--archive-once'].includes(mode!)
)
  throw new Error('EXPLICIT_TRANSCRIPT_ARCHIVE_ACTION_REQUIRED');
if (defaults.paid_services_enabled !== false)
  throw new Error('PAID_POLICY_DENIED');
const now = new Date(),
  day = now.toISOString().slice(0, 10);
const probe = JSON.parse(
  readFileSync('docs/verification/release/d1-probe-' + day + '.json', 'utf8'),
);
if (
  probe.state !== 'AVAILABLE' ||
  Date.parse(probe.observed_at) > now.getTime() ||
  now.getTime() - Date.parse(probe.observed_at) > 15 * 60000
)
  throw new Error('FRESH_ACTUAL_D1_PROBE_REQUIRED');
const sample = JSON.parse(
  readFileSync('.local/d1-usage/latest.json', 'utf8'),
) as UsageSample;
if (!d1UsagePolicy(sample, now).noncritical_admitted)
  throw new Error('D1_TRANSCRIPT_BUDGET_NOT_ADMITTED');
if (
  !process.env.DRIVE_EXPORT_WORKER_CREDENTIAL ||
  !process.env.GOOGLE_DRIVE_CLIENT_ID ||
  !process.env.GOOGLE_DRIVE_CLIENT_SECRET ||
  !process.env.DRIVE_WRAPPING_KEY_ID ||
  !process.env.DRIVE_WRAPPING_KEY ||
  process.env.DRIVE_KEY_RECOVERY_READY !== 'true'
)
  throw new Error('PRIVATE_DRIVE_CONFIGURATION_REQUIRED');
const intent =
  '.local/d1-resume/' + day + '-transcript-' + mode!.slice(2) + '-intent.json';
if (existsSync(intent)) throw new Error('TRANSCRIPT_LIVE_ALREADY_ATTEMPTED');
mkdirSync('.local/d1-resume', { recursive: true });
writeFileSync(
  intent,
  JSON.stringify({
    started_at: now.toISOString(),
    action: mode,
    gemini_requests: 0,
    paid_services_enabled: false,
  }) + '\n',
  { flag: 'wx' },
);
const budget = d1TestBudget(queryBatch, {
    requests: 100,
    rows_read: 15000,
    rows_written: 1000,
  }),
  db = remoteDatabase(budget.execute);
let result: unknown;
try {
  const migrations = (
    await db
      .prepare(
        `SELECT name,sha256 FROM applied_migrations ORDER BY name LIMIT ${ledger.migrations.length + 1}`,
      )
      .all()
  ).results;
  if (
    JSON.stringify(migrations) !==
    JSON.stringify(
      ledger.migrations.map(({ name, sha256 }) => ({ name, sha256 })),
    )
  )
    throw new Error('EXACT_CURRENT_SCHEMA_REQUIRED');
  const context = await AccessContext.worker(
    db,
    await sha256(process.env.DRIVE_EXPORT_WORKER_CREDENTIAL!),
  );
  context.requireTask('DRIVE_EXPORT');
  const row = await db
    .prepare(
      "SELECT connection_id FROM drive_connections WHERE owner_id=? AND root_id=? AND auth_state='CONNECTED' LIMIT 2",
    )
    .bind(context.ownerId, '1rn_5auxY_8HAeADc1RgGKQ6h9JimD7WM')
    .all<{ connection_id: string }>();
  if (row.results.length !== 1)
    throw new Error('APPROVED_DAILY_CONNECTION_REQUIRED');
  const client = async (connectionId: string) => {
    const grant = await refreshDriveAccess(
      db,
      context,
      {
        client_id: process.env.GOOGLE_DRIVE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET!,
        app_origin: process.env.APP_ORIGIN!,
      },
      await importDriveWrappingKey(
        process.env.DRIVE_WRAPPING_KEY_ID!,
        process.env.DRIVE_WRAPPING_KEY!,
      ),
      connectionId,
      new Date(),
    );
    return new DriveClient(grant.access_token);
  };
  result =
    mode === '--provision-folder'
      ? await provisionTranscriptFolder(
          db,
          context,
          await client(row.results[0]!.connection_id),
          {
            connection_id: row.results[0]!.connection_id,
            parent_id: '1aFYzO7kMVebvP-Y-V6oIWAAkf21MR7mN',
          },
          new Date(),
        )
      : await new TranscriptDriveArchive(db, context).tick(
          { client },
          new Date(),
        );
} catch {
  result = {
    state: 'RECOVERY_REQUIRED',
    reason: 'TRANSCRIPT_LIVE_FAILED_NO_AUTOMATIC_RETRY',
  };
  process.exitCode = 2;
}
const output =
  'docs/verification/drive/transcript-' +
  mode!.slice(2) +
  '-' +
  day +
  '-' +
  randomUUID() +
  '.json';
mkdirSync('docs/verification/drive', { recursive: true });
const receipt = {
  version: 'transcript-archive-live:1',
  observed_at: new Date().toISOString(),
  result,
  budget: budget.usage,
  gemini_requests: 0,
  destructive_cleanup: 0,
  paid_services_enabled: false,
};
writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ evidence: output, ...receipt }));
