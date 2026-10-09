import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import {
  restoreCanonical,
  type PortableCoreBackup,
} from '../../../packages/core/src/backup/restore.js';
import {
  AccessContext,
  type Database,
  type Statement,
} from '../../../packages/core/src/db/boundary.js';
import { sha256, randomToken } from '../../../packages/core/src/auth/crypto.js';
import { TranscriptRecovery } from '../../../packages/core/src/transcript/recovery.js';
import { CapacityCollection } from '../../../packages/core/src/projections/capacity-collection.js';
import {
  scheduleMetadataRefresh,
  metadataObservationPredicate,
} from '../../../packages/core/src/sources/youtube/refresh.js';
import {
  CoreBackup,
  backupTables,
} from '../../../packages/core/src/backup/snapshot.js';

// Real local workerd billing counters, never production SQL/provider traffic.
if (
  !(
    process.argv.length === 4 ||
    (process.argv.length === 5 && process.argv[4] === '--full-backup')
  ) ||
  process.argv[2] !== '--backup' ||
  !process.env.GOOGLE_OIDC_OWNER_SUBJECT
)
  throw new Error('EXPLICIT_ISOLATED_BENCHMARK_BACKUP_REQUIRED');
const bytes = readFileSync(process.argv[3]!);
if (bytes.length > 64 * 1024 * 1024) throw new Error('BACKUP_FILE_TOO_LARGE');
const portable = JSON.parse(bytes.toString('utf8')) as PortableCoreBackup;
interface Meta {
  changes: number;
  rows_read: number;
  rows_written: number;
}
interface LocalStatement extends Statement {
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; meta: Meta }>;
  run(): Promise<{ meta: Meta }>;
}
interface LocalDatabase extends Database {
  prepare(sql: string): LocalStatement;
  batch(
    statements: Statement[],
  ): Promise<{ meta: Meta; results?: unknown[] }[]>;
}
const require = createRequire(import.meta.url),
  wrangler = createRequire(require.resolve('wrangler/package.json'));
const runtime = wrangler('miniflare') as {
  convertV4MiniflareOptions(
    input: Record<string, unknown>,
  ): Record<string, unknown>;
  Miniflare: new (input: Record<string, unknown>) => {
    ready: Promise<URL>;
    getD1Database(name: string): Promise<LocalDatabase>;
    dispose(): Promise<void>;
  };
};
const mf = new runtime.Miniflare(
  runtime.convertV4MiniflareOptions({
    modules: true,
    script:
      'export default {fetch(){return new Response("ISOLATED_BENCHMARK")}}',
    d1Databases: ['DB'],
  }),
);
type Trace = { sql: string; params: (string | number | null)[]; meta: Meta };
let traces: Trace[] = [],
  legacy = false;
try {
  await mf.ready;
  const actual = await mf.getD1Database('DB');
  for (const migration of await readD1Migrations('db/migrations'))
    for (const sql of migration.queries) await actual.prepare(sql).run();
  const restored = await restoreCanonical(
    actual,
    portable,
    process.env.GOOGLE_OIDC_OWNER_SUBJECT,
  );
  const handles = new WeakMap<
    Statement,
    () => {
      base: LocalStatement;
      sql: string;
      params: (string | number | null)[];
    }
  >();
  const db: Database = {
    prepare(query) {
      const sql = legacy
        ? query
            .replace(
              " AND a.error_code IN ('LOCAL_YTDLP_IP_BLOCKED','LOCAL_YTDLP_PARSER_CHANGED')",
              '',
            )
            .replace(
              'FROM jobs q CROSS JOIN job_attempts a ON a.owner_id=q.owner_id AND a.job_id=q.job_id',
              'FROM job_attempts a JOIN jobs q ON q.owner_id=a.owner_id AND q.job_id=a.job_id',
            )
            .replace(' NOT INDEXED', '')
            .replace(metadataObservationPredicate, '')
            .replace(
              'FROM item_revisions r CROSS JOIN items i ON i.owner_id=r.owner_id AND i.item_id=r.item_id AND i.current_revision_id=r.revision_id',
              'FROM items i JOIN item_revisions r ON r.owner_id=i.owner_id AND r.item_id=i.item_id AND r.revision_id=i.current_revision_id',
            )
        : query;
      let base = actual.prepare(sql),
        params: (string | number | null)[] = [];
      const statement: Statement = {
        bind(...values) {
          params =
            legacy && query.includes(metadataObservationPredicate)
              ? values.slice(0, -2)
              : values;
          base = base.bind(...params) as LocalStatement;
          return statement;
        },
        async all<T>() {
          const result = await base.all<T>();
          traces.push({ sql, params, meta: result.meta });
          return result;
        },
        async first<T>(column?: string) {
          const result = await statement.all<Record<string, unknown>>();
          const row = result.results[0] ?? null;
          return (column && row ? row[column] : row) as T | null;
        },
        async run() {
          const result = await base.run();
          traces.push({ sql, params, meta: result.meta });
          return result;
        },
      };
      handles.set(statement, () => ({ base, sql, params }));
      return statement;
    },
    async batch(statements) {
      const prepared = statements.map((s) => handles.get(s)!());
      const result = await actual.batch(prepared.map((s) => s.base));
      result.forEach((r, i) => traces.push({ ...prepared[i]!, meta: r.meta }));
      return result;
    },
  };
  const now = new Date(),
    ownerId = portable.manifest.owner_id,
    session = await sha256(randomToken()),
    credential = await sha256(randomToken());
  await actual
    .prepare(
      'INSERT INTO owner_sessions(session_hash,owner_id,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?)',
    )
    .bind(
      session,
      ownerId,
      await sha256(randomToken()),
      now.toISOString(),
      new Date(now.getTime() + 900000).toISOString(),
    )
    .run();
  await actual
    .prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'd1-cost-probe',
      ownerId,
      credential,
      '["FETCH_TRANSCRIPT","PROJECT"]',
      now.toISOString(),
    )
    .run();
  const owner = await AccessContext.owner(db, session, now.toISOString()),
    worker = await AccessContext.worker(db, credential),
    secret = randomToken();
  const operations: {
    phase: string;
    label: string;
    queries: number;
    rows_read: number;
    rows_written: number;
    elapsed_ms: number;
    result_sha256: string;
    plans: { query_sha256: string; details: unknown[] }[];
  }[] = [];
  async function measure(
    phase: string,
    label: string,
    operation: () => Promise<unknown>,
    normalize: (result: unknown) => unknown = (v) => v,
  ) {
    traces = [];
    const started = performance.now(),
      result = await operation();
    const elapsed = performance.now() - started,
      plans = [];
    const planned = new Set<string>();
    for (const trace of traces.filter((t) => t.sql.startsWith('SELECT'))) {
      if (planned.has(trace.sql)) continue;
      planned.add(trace.sql);
      const plan = await actual
        .prepare('EXPLAIN QUERY PLAN ' + trace.sql)
        .bind(...trace.params)
        .all<{ detail: string }>();
      plans.push({
        query_sha256: await sha256(trace.sql),
        details: plan.results.map((r) => r.detail),
      });
    }
    operations.push({
      phase,
      label,
      queries: traces.length,
      rows_read: traces.reduce((n, t) => n + t.meta.rows_read, 0),
      rows_written: traces.reduce((n, t) => n + t.meta.rows_written, 0),
      elapsed_ms: elapsed,
      result_sha256: await sha256(JSON.stringify(normalize(result))),
      plans,
    });
    return result;
  }
  const indexes = [
    'transcript_admission_errors',
    'capacity_accepted_item',
    'metadata_refresh_active',
    'metadata_revision_due',
    'metadata_observation_item',
  ];
  for (const name of indexes) await actual.prepare('DROP INDEX ' + name).run();
  let indexCost: Meta | undefined;
  for (const phase of ['before', 'after']) {
    legacy = phase === 'before';
    if (!legacy) {
      const migration = (await readD1Migrations('db/migrations')).find(
        (m) => m.name === '036_d1_read_indexes.sql',
      )!;
      for (const sql of migration.queries) {
        const result = await actual.prepare(sql).run();
        indexCost = {
          changes: (indexCost?.changes ?? 0) + result.meta.changes,
          rows_read: (indexCost?.rows_read ?? 0) + result.meta.rows_read,
          rows_written:
            (indexCost?.rows_written ?? 0) + result.meta.rows_written,
        };
      }
    }
    await measure(phase, 'transcript_admission', () =>
      new TranscriptRecovery(db, worker).admission(now, 'local'),
    );
    await measure(phase, 'capacity_page', () =>
      new CapacityCollection(db, owner).page(50, secret, now),
    );
    await measure(phase, 'metadata_refresh', () =>
      scheduleMetadataRefresh(db, now),
    );
    const backup = new CoreBackup(db, owner),
      start = await backup.begin(2);
    try {
      await measure(
        phase,
        'backup_attempt_chunk',
        () => backup.chunk(start.backup_id, 'job_attempts', 0),
        (value) => {
          const r = value as {
            rows: unknown[];
            cursor: number;
            next_cursor: number | null;
            sha256: string;
          };
          return {
            rows: r.rows,
            cursor: r.cursor,
            next_cursor: r.next_cursor,
            sha256: r.sha256,
          };
        },
      );
    } finally {
      await backup.abort(start.backup_id);
    }
    if (process.argv[4] === '--full-backup') {
      await measure(phase, 'canonical_backup', async () => {
        const capture = new CoreBackup(db, owner),
          started = await capture.begin(2);
        try {
          for (const table of backupTables) {
            let cursor: number | null = 0;
            do {
              const chunk = await capture.chunk(
                started.backup_id,
                table,
                cursor,
              );
              cursor = chunk.next_cursor;
            } while (cursor !== null);
          }
          const manifest = await capture.complete(started.backup_id);
          return Object.fromEntries(
            Object.entries(manifest.tables).map(([table, spec]) => [
              table,
              {
                count: spec.count,
                hashes: spec.chunks.map((chunk) => chunk.sha256),
              },
            ]),
          );
        } finally {
          await capture.abort(started.backup_id);
        }
      });
    }
  }
  const comparisons = operations
    .filter((o) => o.phase === 'before')
    .map((before) => {
      const after = operations.find(
        (o) => o.phase === 'after' && o.label === before.label,
      )!;
      if (
        before.result_sha256 !== after.result_sha256 ||
        after.rows_read >= before.rows_read
      )
        throw new Error(
          'D1_COST_OR_RESULT_REGRESSION_' + before.label.toUpperCase(),
        );
      return {
        operation: before.label,
        before_rows_read: before.rows_read,
        after_rows_read: after.rows_read,
        results_equal: true,
        write_count_equal: before.rows_written === after.rows_written,
      };
    });
  const output = {
    version: 'D1CostComparison/1.0',
    observed_at: now.toISOString(),
    basis: 'ACTUAL_LOCAL_WORKERD_META_NOT_PRODUCTION',
    status: 'PASS',
    backup_sha256: createHash('sha256').update(bytes).digest('hex'),
    restored_rows: restored.rows,
    corpus: Object.fromEntries(
      Object.entries(portable.manifest.tables).map(([name, spec]) => [
        name,
        spec.count,
      ]),
    ),
    comparisons,
    operations,
    index_creation_cost: indexCost,
    provider_requests: 0,
    paid_services_enabled: false,
  };
  mkdirSync('docs/verification/release', { recursive: true });
  const path =
    'docs/verification/release/d1-cost-comparison-' +
    now.toISOString().replaceAll(':', '-') +
    '.json';
  writeFileSync(path, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
  console.log(
    JSON.stringify({
      status: output.status,
      comparisons,
      index_creation_cost: indexCost,
      evidence: path,
    }),
  );
} finally {
  await mf.dispose();
}
