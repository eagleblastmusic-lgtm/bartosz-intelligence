import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  restoreCanonical,
  type PortableCoreBackup,
} from '../../../packages/core/src/backup/restore.js';
import { sqliteAdapter } from '../../db/sqlite-adapter.js';
import { requirePrivateRecoveryDirectory } from '../../db/private-directory.js';
import { issueSession } from '../../../packages/core/src/auth/session.js';
import { randomToken, sha256 } from '../../../packages/core/src/auth/crypto.js';
import { AccessContext } from '../../../packages/core/src/db/boundary.js';
import { SearchIndex } from '../../../packages/core/src/knowledge/search-index.js';
import { candidatePins } from '../../release/pins.js';

// Extends the already verified independent Drive copy to actual application
// handlers and derived search. Node/SQLite equivalent, not a new cloud install.
const args = process.argv.slice(2);
// Load the Worker at runtime; its Cloudflare type project stays separate from
// Node tooling to avoid ambient Buffer collisions.
const workerModule = '../../../apps/api/src/index.js';
const worker = (await import(workerModule)).default as {
  fetch(
    request: Request,
    environment: Record<string, unknown>,
  ): Promise<Response>;
};
if (
  args.length !== 2 ||
  args[0] !== '--drive-copy' ||
  !process.env.GOOGLE_OIDC_OWNER_SUBJECT
)
  throw new Error('EXPLICIT_VERIFIED_DRIVE_COPY_REQUIRED');
const pins = candidatePins(),
  started = performance.now();
const receipt = JSON.parse(
  readFileSync(
    'docs/verification/backup/drive-5a30668c-f9f2-4aae-b965-b9e15dc9c073.json',
    'utf8',
  ),
);
const bytes = readFileSync(args[1]!);
const hash = createHash('sha256').update(bytes).digest('hex');
if (receipt.status !== 'PASS' || receipt.canonical_sha256 !== hash)
  throw new Error('DRIVE_COPY_HASH_MISMATCH');
const portable = JSON.parse(bytes.toString('utf8')) as PortableCoreBackup;
const id = randomUUID(),
  root = resolve('.local/application-recovery', id);
requirePrivateRecoveryDirectory(root);
const sqlite = new DatabaseSync(join(root, 'restored.sqlite'));
try {
  sqlite.exec('PRAGMA foreign_keys=ON');
  const ledger = JSON.parse(readFileSync('db/migration-ledger.json', 'utf8'));
  for (const migration of ledger.migrations)
    sqlite.exec(readFileSync('db/migrations/' + migration.name, 'utf8'));
  const db = sqliteAdapter(sqlite),
    dbStart = performance.now();
  const restored = await restoreCanonical(
    db,
    portable,
    process.env.GOOGLE_OIDC_OWNER_SUBJECT,
  );
  const databaseMs = Math.ceil(performance.now() - dbStart);
  const invalidated =
    sqlite
      .prepare('SELECT COUNT(*) n FROM owner_sessions WHERE revoked_at IS NULL')
      .get()!.n === 0;
  const secret = randomToken(),
    now = new Date();
  const session = await issueSession(
    db,
    {
      issuer: 'https://accounts.google.com',
      subject: process.env.GOOGLE_OIDC_OWNER_SUBJECT,
    },
    secret,
    now,
  );
  const signed = session.cookie.split(';')[0]!,
    rawToken = signed.split('=')[1]!.split('.')[0]!;
  const owner = await AccessContext.owner(
    db,
    await sha256(rawToken),
    now.toISOString(),
  );
  const index = new SearchIndex(db, owner),
    indexStart = performance.now();
  await index.rebuild(now);
  let searchState = await index.metadata();
  for (let step = 0; step < 1000 && searchState.freshness !== 'FRESH'; step++) {
    await index.step(new Date());
    searchState = await index.metadata();
  }
  if (searchState.freshness !== 'FRESH')
    throw new Error('RESTORED_SEARCH_NOT_FRESH');
  const indexMs = Math.ceil(performance.now() - indexStart);
  const html = readFileSync('apps/web/dist/index.html');
  const environment = {
    DB: db,
    SESSION_SIGNING_SECRET: secret,
    APP_ORIGIN: 'https://recovery.invalid',
    BARTOSZ_QUEUE: {
      send: async () => {
        throw new Error('RECOVERY_PROVIDER_REQUEST_DENIED');
      },
    },
    ASSETS: {
      fetch: async () =>
        new Response(html, { headers: { 'Content-Type': 'text/html' } }),
    },
  };
  const fetchApp = (path: string, authorized = true) =>
    worker.fetch(
      new Request('https://recovery.invalid' + path, {
        headers: authorized ? { Cookie: signed } : {},
      }),
      environment,
    );
  const paths = [
    '/health',
    '/',
    '/api/v1/items?limit=20',
    '/api/v1/daily?date=2026-10-02',
    '/api/v1/search?q=TED',
  ];
  const checks = [];
  for (const path of paths) {
    const response = await fetchApp(path),
      body = await response.text();
    checks.push({
      path,
      status: response.status,
      bytes: Buffer.byteLength(body),
      sha256: createHash('sha256').update(body).digest('hex'),
    });
    if (response.status !== 200 || !body.length)
      throw new Error(
        'RESTORED_APPLICATION_ROUTE_FAILED:' + path + ':' + response.status,
      );
  }
  const denied = (await fetchApp('/api/v1/items', false)).status === 401;
  const source = sqlite
    .prepare(
      "SELECT artifact_id FROM artifacts WHERE kind='SOURCE_ORIGINAL' AND state='VERIFIED' LIMIT 1",
    )
    .get();
  if (!source) throw new Error('RESTORED_SOURCE_REQUIRED');
  const integrity =
    sqlite.prepare('PRAGMA integrity_check').get()!.integrity_check === 'ok';
  const foreignKeys =
    sqlite.prepare('PRAGMA foreign_key_check').all().length === 0;
  const report = {
    version: 'ApplicationRestoreEquivalent/1.0',
    observed_at: new Date().toISOString(),
    ...pins,
    status: denied && invalidated && integrity && foreignKeys ? 'PASS' : 'FAIL',
    runtime: 'ACTUAL_NODE_SQLITE_APPLICATION_HANDLERS',
    independent_medium: 'PREVIOUSLY_DOWNLOADED_VERIFIED_GOOGLE_DRIVE',
    backup_sha256: hash,
    restored_rows: restored.rows,
    canonical_readback: restored.canonical_readback,
    database_restore_ms: databaseMs,
    search_rebuild_ms: indexMs,
    application_handlers_recovery_ms: Math.ceil(performance.now() - started),
    unauthorized_denied: denied,
    old_sessions_invalidated: invalidated,
    integrity,
    foreign_keys: foreignKeys,
    routes: checks,
    live_owner_oidc: 'NOT_RUN',
    workerd_deployment: 'NOT_RUN',
    executor_reprovision: 'NOT_RUN',
    full_application_rpo_rto: 'NOT_QUALIFIED',
    provider_requests: 0,
    paid_services_enabled: false,
  };
  mkdirSync('docs/verification/backup', { recursive: true });
  writeFileSync(
    'docs/verification/backup/application-' + id + '.json',
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(JSON.stringify(report));
  if (report.status !== 'PASS') process.exitCode = 2;
} finally {
  sqlite.close();
}
