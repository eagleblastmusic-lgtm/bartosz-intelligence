import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import {
  restoreCanonical,
  verifyPortableBackup,
  type PortableCoreBackup,
} from '../../../packages/core/src/backup/restore.js';
import {
  AccessContext,
  type Database,
  type Statement,
} from '../../../packages/core/src/db/boundary.js';
import {
  RetentionCleanup,
  cleanupStages,
} from '../../../packages/core/src/retention/cleanup.js';
import { SearchIndex } from '../../../packages/core/src/knowledge/search-index.js';
import { sha256, randomToken } from '../../../packages/core/src/auth/crypto.js';
if (
  ![6, 7].includes(process.argv.length) ||
  (process.argv.length === 7 && process.argv[6] !== '--high') ||
  process.argv[2] !== '--isolated-fixture' ||
  process.argv[4] !== '--source-backup'
)
  throw Error('EXPLICIT_LOCAL_INPUTS_REQUIRED');
const fixtureBytes = readFileSync(process.argv[3]!),
  sourceBytes = readFileSync(process.argv[5]!);
if (Math.max(fixtureBytes.length, sourceBytes.length) > 64 * 1024 * 1024)
  throw Error('INPUT_TOO_LARGE');
const fixture = JSON.parse(fixtureBytes.toString()) as PortableCoreBackup,
  source = JSON.parse(sourceBytes.toString()) as PortableCoreBackup;
await verifyPortableBackup(fixture);
await verifyPortableBackup(source);
const require = createRequire(import.meta.url),
  wrangler = createRequire(require.resolve('wrangler/package.json'));
type Meta = {
  rows_read: number;
  rows_written: number;
  changes: number;
  size_after?: number;
};
interface LocalStatement extends Statement {
  bind(...v: (string | number | null)[]): LocalStatement;
  all<T>(): Promise<{ results: T[]; meta: Meta }>;
  run(): Promise<{ meta: Meta }>;
}
interface LocalDb extends Database {
  prepare(sql: string): LocalStatement;
  batch(s: Statement[]): Promise<{ meta: Meta; results?: unknown[] }[]>;
}
const runtime = wrangler('miniflare') as {
  convertV4MiniflareOptions(
    a: Record<string, unknown>,
  ): Record<string, unknown>;
  Miniflare: new (a: Record<string, unknown>) => {
    ready: Promise<URL>;
    getD1Database(n: string): Promise<LocalDb>;
    dispose(): Promise<void>;
  };
};
const mf = new runtime.Miniflare(
  runtime.convertV4MiniflareOptions({
    modules: true,
    script:
      'export default {fetch(){return new Response("ISOLATED_RETENTION_BENCHMARK")}}',
    d1Databases: ['DB'],
  }),
);
try {
  await mf.ready;
  const actual = await mf.getD1Database('DB');
  for (const migration of await readD1Migrations('db/migrations'))
    for (const sql of migration.queries) await actual.prepare(sql).run();
  await restoreCanonical(actual, fixture, 'subject-a');
  const target = await actual
    .prepare('SELECT item_id FROM retention_items LIMIT 1')
    .first<string>('item_id');
  if (!target) throw Error('NO_RETENTION_FIXTURE');
  const originals = source.chunks
    .filter((c) => c.table === 'artifacts')
    .flatMap((c) => c.rows);
  const totals = new Map<string, number>();
  for (const row of originals) {
    const id = String(row.item_id);
    totals.set(id, (totals.get(id) ?? 0) + Number(row.byte_size));
  }
  const measured = [...totals].sort((a, b) => a[1] - b[1]),
    median =
      measured[
        process.argv[6] === '--high'
          ? measured.length - 1
          : Math.floor(measured.length / 2)
      ]!;
  const chosen = originals.filter((r) => r.item_id === median[0]),
    ids = new Set(chosen.map((r) => r.artifact_id));
  // Real bytes from one median-sized SOURCE item; AI/export acceptance fixture is
  // synthetic and explicitly cannot qualify a live production acceptance gate.
  for (const table of [
    'artifacts',
    'artifact_chunks',
    'transcript_representations',
  ]) {
    const rows = source.chunks
      .filter((c) => c.table === table)
      .flatMap((c) => c.rows)
      .filter((r) => ids.has(r.artifact_id));
    for (const original of rows) {
      const row = { ...original, owner_id: 'a', item_id: target };
      const columns = Object.keys(row);
      await actual
        .prepare(
          `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
        )
        .bind(...Object.values(row))
        .run();
    }
  }
  const now = new Date('2026-10-17T12:00:00.000Z'),
    session = await sha256(randomToken());
  await actual
    .prepare(
      'INSERT INTO owner_sessions(session_hash,owner_id,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?)',
    )
    .bind(
      session,
      'a',
      await sha256(randomToken()),
      now.toISOString(),
      '2099-01-01T00:00:00.000Z',
    )
    .run();
  const owner = await AccessContext.owner(actual, session, now.toISOString());
  await actual
    .prepare(
      "UPDATE drive_connections SET auth_state='CONNECTED',root_state='VERIFIED' WHERE owner_id='a'",
    )
    .run();
  await actual
    .prepare(
      "UPDATE retention_settings SET deletion_enabled=1,approval_reference='ISOLATED_BENCHMARK_ONLY' WHERE owner_id='a'",
    )
    .run();
  const index = new SearchIndex(actual, owner);
  for (let n = 0; n < 100; n++) {
    if (!(await index.step(now)).progressed) break;
  }
  const before = await actual
    .prepare(
      'SELECT COALESCE(SUM(byte_size),0) bytes,COUNT(*) chunks FROM artifact_chunks WHERE owner_id=? AND item_id=?',
    )
    .bind('a', target)
    .first();
  const retentionPlan = await actual
    .prepare(
      "EXPLAIN QUERY PLAN SELECT item_id FROM retention_items WHERE owner_id=? AND phase!='COMPLETE' ORDER BY purge_after,item_id LIMIT 50",
    )
    .bind('a')
    .all<{ detail: string }>();
  if (!retentionPlan.results.some((r) => r.detail.includes('retention_due')))
    throw Error('RETENTION_DUE_INDEX_NOT_USED');
  // Same corpus and predicates, forcing the historical owner-prefix index
  // versus the new owner/item index. Returned rows are not billed-row counts.
  const chunkQueries = [];
  for (const index of [
    'sqlite_autoindex_artifact_chunks_1',
    'artifact_chunk_retention',
  ]) {
    const sql = `SELECT COALESCE(SUM(byte_size),0) bytes,COUNT(*) chunks FROM artifact_chunks INDEXED BY ${index} WHERE owner_id=? AND item_id=?`;
    const measured = await actual.prepare(sql).bind('a', target).all();
    const plan = await actual
      .prepare('EXPLAIN QUERY PLAN ' + sql)
      .bind('a', target)
      .all();
    chunkQueries.push({
      index,
      results: measured.results,
      rows_read: measured.meta.rows_read,
      rows_written: measured.meta.rows_written,
      plan: plan.results,
    });
  }
  const pages = async () => {
    const result: Record<string, unknown> = {};
    for (const name of [
      'page_count',
      'freelist_count',
      'page_size',
      'auto_vacuum',
    ])
      try {
        result[name] = (await actual.prepare('PRAGMA ' + name).all()).results;
      } catch {
        result[name] = 'UNAVAILABLE_IN_LOCAL_D1';
      }
    return result;
  };
  const storageBefore = await pages(),
    sizeBefore =
      (await actual.prepare('SELECT 1 n').all()).meta.size_after ?? null,
    meta: Meta[] = [];
  const handles = new WeakMap<Statement, Statement>();
  const db: Database = {
    prepare(sql) {
      let base = actual.prepare(sql);
      const wrapped: Statement = {
        bind(...v) {
          base = base.bind(...v) as typeof base;
          handles.set(wrapped, base);
          return wrapped;
        },
        async all<T>() {
          const r = await base.all<T>();
          meta.push(r.meta);
          return r;
        },
        async first<T>(column?: string) {
          const r = await wrapped.all<Record<string, unknown>>(),
            row = r.results[0];
          return (row ? (column ? row[column] : row) : null) as T | null;
        },
        async run() {
          const r = await base.run();
          meta.push(r.meta);
          return r;
        },
      };
      handles.set(wrapped, base);
      return wrapped;
    },
    async batch(s) {
      const r = await actual.batch(s.map((x) => handles.get(x)!));
      r.forEach((x) => meta.push(x.meta));
      return r;
    },
  };
  const row = (await actual
    .prepare('SELECT * FROM retention_items WHERE item_id=?')
    .bind(target)
    .first<Record<string, string>>())!;
  const body = Buffer.from(
    String(
      fixture.chunks.find((c) => c.table === 'daily_export_chunks')!.rows[0]!
        .data_base64,
    ),
    'base64url',
  ).toString();
  let remoteReads = 0;
  const client = {
    async getFile() {
      remoteReads++;
      return {
        id: row.file_id!,
        name: 'fixture.md',
        mimeType: 'text/markdown',
        parents: [row.root_id!],
        trashed: false,
        version: row.remote_version!,
      };
    },
    async readMarkdown() {
      remoteReads++;
      return body;
    },
  };
  const steps = [];
  let status = 'FAIL';
  const dryStart = meta.length;
  await new RetentionCleanup(db, owner).dryRun(now);
  const dry = meta.splice(dryStart);
  for (let n = 0; n < 200; n++) {
    const start = meta.length,
      receipt = await new RetentionCleanup(db, owner).step(target, client, now),
      cost = meta.slice(start);
    steps.push({
      table: 'table' in receipt ? receipt.table : null,
      state: receipt.state,
      rows_read: cost.reduce((s, r) => s + r.rows_read, 0),
      rows_written: cost.reduce((s, r) => s + r.rows_written, 0),
      queries: cost.length,
    });
    const checkpoint = await actual
      .prepare('SELECT phase FROM retention_items WHERE item_id=?')
      .bind(target)
      .first<string>('phase');
    if (checkpoint === 'COMPLETE') {
      status = 'PASS';
      break;
    }
    if (receipt.state === 'HELD') throw Error('UNEXPECTED_RETENTION_HOLD');
  }
  if (status !== 'PASS') throw Error('RETENTION_NOT_COMPLETED');
  const activeStatus = await new RetentionCleanup(actual, owner).status();
  if (
    activeStatus.items.some(
      (r) => (r as { item_id: string }).item_id === target,
    )
  )
    throw Error('COMPLETED_ITEM_IN_ACTIVE_STATUS');
  const after = await actual
    .prepare(
      'SELECT COUNT(*) chunks FROM artifact_chunks WHERE owner_id=? AND item_id=?',
    )
    .bind('a', target)
    .first();
  if (
    Number(after?.chunks) !== 0 ||
    (await actual.prepare('PRAGMA foreign_key_check').all()).results.length
  )
    throw Error('RETENTION_INTEGRITY_FAILURE');
  const checkpoint = await actual
    .prepare(
      'SELECT phase,step,deleted_rows,deleted_bytes FROM retention_items WHERE item_id=?',
    )
    .bind(target)
    .first();
  const output = {
    version: 'RetentionLocalCost/1.0',
    observed_at: new Date().toISOString(),
    status,
    completed_item_excluded_from_active_status: true,
    basis:
      'ACTUAL_LOCAL_WORKERD_META_REAL_SOURCE_BYTES_SYNTHETIC_ACCEPTED_EXPORT',
    fixture_sha256: createHash('sha256').update(fixtureBytes).digest('hex'),
    source_backup_sha256: createHash('sha256')
      .update(sourceBytes)
      .digest('hex'),
    source_sample_items: measured.length,
    selected_sample:
      process.argv[6] === '--high'
        ? 'MAXIMUM_OBSERVED_SOURCE_ITEM'
        : 'MEDIAN_OBSERVED_SOURCE_ITEM',
    sample_mean_logical_bytes:
      measured.reduce((sum, row) => sum + row[1], 0) / measured.length,
    median_item_logical_bytes: median[1],
    source_bytes_before: before,
    retention_due_plan: retentionPlan.results,
    chunk_index_comparison: chunkQueries,
    source_chunks_after: after,
    checkpoint,
    steps,
    stage_count: cleanupStages.length,
    totals: {
      rows_read: meta.reduce((s, r) => s + r.rows_read, 0),
      rows_written: meta.reduce((s, r) => s + r.rows_written, 0),
    },
    dry_run: {
      rows_read: dry.reduce((s, r) => s + r.rows_read, 0),
      rows_written: dry.reduce((s, r) => s + r.rows_written, 0),
    },
    storage_before: storageBefore,
    storage_after: await pages(),
    size_before_bytes: sizeBefore,
    size_after_bytes:
      (await actual.prepare('SELECT 1 n').all()).meta.size_after ?? null,
    simulated_drive_reads: remoteReads,
    production_d1_requests: 0,
    live_drive_requests: 0,
    gemini_requests: 0,
    paid_services_enabled: false,
  };
  mkdirSync('docs/verification/retention', { recursive: true });
  const path =
    'docs/verification/retention/local-cost-' + crypto.randomUUID() + '.json';
  writeFileSync(path, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
  console.log(
    JSON.stringify({
      status,
      totals: output.totals,
      dry_run: output.dry_run,
      evidence: path,
    }),
  );
} finally {
  await mf.dispose();
}
