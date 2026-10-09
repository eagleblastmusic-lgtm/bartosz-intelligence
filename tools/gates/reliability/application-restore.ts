import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import {
  restoreCanonical,
  type PortableCoreBackup,
} from '../../../packages/core/src/backup/restore.js';
import { requirePrivateRecoveryDirectory } from '../../db/private-directory.js';
import { issueSession } from '../../../packages/core/src/auth/session.js';
import { randomToken, sha256 } from '../../../packages/core/src/auth/crypto.js';
import {
  AccessContext,
  type Database,
} from '../../../packages/core/src/db/boundary.js';
import { SearchIndex } from '../../../packages/core/src/knowledge/search-index.js';
import { candidatePins } from '../../release/pins.js';
import application from '../../../config/application.json';

// Extends the already verified independent Drive copy to actual application
// workerd, static assets and derived search. Not a new cloud/OIDC installation.
const args = process.argv.slice(2);
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
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const runtime = wranglerRequire('miniflare') as {
  convertV4MiniflareOptions(
    options: Record<string, unknown>,
  ): Record<string, unknown>;
  Miniflare: new (options: Record<string, unknown>) => {
    ready: Promise<URL>;
    getD1Database(name: string): Promise<Database>;
    dispatchFetch(url: string, init?: RequestInit): Promise<Response>;
    dispose(): Promise<void>;
  };
};
const secret = randomToken();
const assetsRoot = resolve('apps/web/dist');
const runtimeOptions = {
  ...runtime.convertV4MiniflareOptions({
    modules: true,
    script: readFileSync('apps/api/dist/index.js', 'utf8'),
    compatibilityDate: '2026-10-01',
    host: '127.0.0.1',
    port: 0,
    d1Databases: ['DB'],
    queueProducers: { BARTOSZ_QUEUE: 'isolated-recovery' },
    bindings: {
      SESSION_SIGNING_SECRET: secret,
      APP_ORIGIN: application.app_origin,
      GOOGLE_OIDC_CLIENT_ID: 'isolated-recovery',
      GOOGLE_OIDC_CLIENT_SECRET: 'isolated-recovery',
      GOOGLE_OIDC_OWNER_SUBJECT: process.env.GOOGLE_OIDC_OWNER_SUBJECT,
    },
    outboundService: () =>
      new Response('RECOVERY_EXTERNAL_REQUEST_DENIED', { status: 503 }),
    serviceBindings: {
      ASSETS: (request: Request) => {
        const path = new URL(request.url).pathname;
        const file = path.startsWith('/assets/')
          ? resolve(assetsRoot, '.' + path)
          : join(assetsRoot, 'index.html');
        if (!file.startsWith(assetsRoot + '\\'))
          return new Response(null, { status: 404 });
        const type = file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : 'text/html';
        return new Response(readFileSync(file), {
          headers: { 'Content-Type': type },
        });
      },
    },
  }),
  resourcePersistencePath: root,
};
const mf = new runtime.Miniflare(runtimeOptions);
let disposed = false;
try {
  await mf.ready;
  const db = await mf.getD1Database('DB');
  const ledger = JSON.parse(readFileSync('db/migration-ledger.json', 'utf8'));
  const migrations = await readD1Migrations('db/migrations');
  for (const migration of ledger.migrations) {
    const parsed = migrations.find((row) => row.name === migration.name);
    if (!parsed) throw new Error('RESTORE_MIGRATION_MISSING');
    for (const query of parsed.queries) await db.prepare(query).run();
  }
  const dbStart = performance.now();
  const restored = await restoreCanonical(
    db,
    portable,
    process.env.GOOGLE_OIDC_OWNER_SUBJECT,
  );
  const databaseMs = Math.ceil(performance.now() - dbStart);
  const invalidated =
    (await db
      .prepare('SELECT COUNT(*) n FROM owner_sessions WHERE revoked_at IS NULL')
      .first<number>('n')) === 0;
  const now = new Date();
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
  const fetchApp = (path: string, authorized = true) =>
    mf.dispatchFetch(application.app_origin + path, {
      headers: authorized ? { Cookie: signed } : {},
    });
  const paths = [
    '/health',
    '/',
    '/api/v1/items?limit=20',
    '/api/v1/daily?date=2026-10-02',
    '/api/v1/search?q=TED',
    ...new Set(
      readFileSync('apps/web/dist/index.html', 'utf8').match(
        /\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g,
      ) ?? [],
    ),
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
  const source = await db
    .prepare(
      "SELECT artifact_id FROM artifacts WHERE kind='SOURCE_ORIGINAL' AND state='VERIFIED' LIMIT 1",
    )
    .first();
  if (!source) throw new Error('RESTORED_SOURCE_REQUIRED');
  const quickCheck =
    (await db.prepare('PRAGMA quick_check').first<string>('quick_check')) ===
    'ok';
  const foreignKeys =
    (await db.prepare('PRAGMA foreign_key_check').all()).results.length === 0;
  // D1 forbids integrity_check. Retain the stronger check against the same
  // persisted isolated database after workerd has released its file handles.
  await mf.dispose();
  disposed = true;
  const files = readdirSync(
    join(root, 'd1', 'miniflare-D1DatabaseObject'),
  ).filter((file) => /^[a-f0-9]{64}\.sqlite$/.test(file));
  if (files.length !== 1)
    throw new Error('ISOLATED_RESTORE_DATABASE_AMBIGUOUS');
  const physical = new DatabaseSync(
    join(root, 'd1', 'miniflare-D1DatabaseObject', files[0]!),
    {
      readOnly: true,
    },
  );
  let integrity: boolean;
  try {
    integrity =
      physical.prepare('PRAGMA integrity_check').get()!.integrity_check ===
      'ok';
  } finally {
    physical.close();
  }
  const restarted = new runtime.Miniflare(runtimeOptions);
  let restartVerified = false;
  try {
    await restarted.ready;
    const response = await restarted.dispatchFetch(
      application.app_origin + '/api/v1/items?limit=20',
      { headers: { Cookie: signed } },
    );
    const body = await response.text();
    restartVerified = response.status === 200 && body.length > 0;
    if (!restartVerified) throw new Error('RESTORED_RUNTIME_RESTART_FAILED');
  } finally {
    await restarted.dispose();
  }
  const report = {
    version: 'ApplicationRestoreWorkerd/1.0',
    observed_at: new Date().toISOString(),
    ...pins,
    status:
      denied &&
      invalidated &&
      integrity &&
      quickCheck &&
      foreignKeys &&
      restartVerified
        ? 'PASS'
        : 'FAIL',
    runtime: 'ACTUAL_LOCAL_WORKERD_D1_APPLICATION',
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
    quick_check: quickCheck,
    integrity_basis: 'SAME_PERSISTED_ISOLATED_D1_OFFLINE_SQLITE',
    persisted_runtime_restart: restartVerified,
    foreign_keys: foreignKeys,
    routes: checks,
    live_owner_oidc: 'NOT_RUN',
    workerd_deployment: 'PASS_LOCAL_ISOLATED',
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
  if (!disposed) await mf.dispose();
}
