import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { cf, account } from './cloudflare.mjs';
import { createHash } from 'node:crypto';
const app = JSON.parse(readFileSync('config/application.json', 'utf8'));
if (
  process.env.APP_ORIGIN !== app.app_origin ||
  app.paid_services_enabled !== false
)
  throw new Error('FREE_ORIGIN_REQUIRED');
const eligibility = JSON.parse(
  readFileSync('docs/verification/gate-e/dashboard-observations.json', 'utf8'),
);
if (
  eligibility.cloudflare?.plan !== 'Workers Free' ||
  eligibility.paid_services_enabled !== false ||
  eligibility.cloudflare.account_pseudonym !==
    `cf-${createHash('sha256')
      .update(account ?? '')
      .digest('hex')
      .slice(0, 16)}`
)
  throw new Error('FREE_ACCOUNT_EVIDENCE_REQUIRED');
const settings = await cf('workers/account-settings');
console.log(
  JSON.stringify({
    account_settings: {
      default_usage_model: settings.default_usage_model ?? null,
      keys: Object.keys(settings).filter((key) => !key.includes('token')),
    },
  }),
);
if (settings.default_usage_model !== 'standard')
  throw new Error('WORKERS_FREE_ACCOUNT_RECHECK_REQUIRED');
const databases = await cf('d1/database?per_page=100');
const queues = await cf('queues?per_page=100');
const databaseName = 'bartosz-intelligence-core',
  queueName = 'bartosz-intelligence-signals';
let db = databases.find((row) => row.name === databaseName),
  queue = queues.find((row) => row.queue_name === queueName);
const prior = existsSync('config/deployment.json')
  ? JSON.parse(readFileSync('config/deployment.json', 'utf8'))
  : null;
if ((db || queue) && !prior)
  throw new Error('RESOURCE_OWNERSHIP_REVIEW_REQUIRED');
if (!db)
  db = await cf('d1/database', 'POST', {
    name: databaseName,
    primary_location_hint: 'weur',
  });
if (!queue)
  queue = await cf('queues', 'POST', {
    queue_name: queueName,
    settings: { message_retention_period: 86400 },
  });
if (
  prior &&
  (prior.database_id !== db.uuid || prior.queue_id !== queue.queue_id)
)
  throw new Error('RESOURCE_ID_MISMATCH');
const record = {
  worker_name: app.worker_name,
  app_origin: app.app_origin,
  database_name: databaseName,
  database_id: db.uuid,
  queue_name: queueName,
  queue_id: queue.queue_id,
  paid_services_enabled: false,
  provisioned_at: prior?.provisioned_at ?? new Date().toISOString(),
};
writeFileSync('config/deployment.json', JSON.stringify(record, null, 2) + '\n');
const config = {
  $schema: '../../node_modules/wrangler/config-schema.json',
  name: app.worker_name,
  account_id: account,
  main: 'src/index.ts',
  compatibility_date: '2026-10-01',
  workers_dev: true,
  preview_urls: false,
  observability: { enabled: false },
  assets: {
    directory: '../web/dist',
    binding: 'ASSETS',
    not_found_handling: 'single-page-application',
    run_worker_first: ['/api', '/api/*', '/internal/*', '/health'],
  },
  vars: { APP_ORIGIN: app.app_origin, TRANSCRIPT_ARCHIVE_ENABLED: 'true' },
  d1_databases: [
    {
      binding: 'DB',
      database_name: databaseName,
      database_id: db.uuid,
      migrations_dir: '../../db/migrations',
    },
  ],
  queues: {
    producers: [{ binding: 'BARTOSZ_QUEUE', queue: queueName }],
    consumers: [
      {
        queue: queueName,
        max_retries: 0,
        max_batch_size: 1,
        max_concurrency: 1,
      },
    ],
  },
  triggers: { crons: ['*/5 * * * *'] },
};
writeFileSync(
  'apps/api/wrangler.production.json',
  JSON.stringify(config, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    result: 'PROVISIONED',
    database_id: db.uuid,
    queue_id: queue.queue_id,
    paid_services_enabled: false,
  }),
);
