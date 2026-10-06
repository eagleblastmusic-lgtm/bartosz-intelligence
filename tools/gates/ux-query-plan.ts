import { DatabaseSync } from 'node:sqlite';
import { sqliteAdapter } from '../db/sqlite-adapter.js';
import {
  AccessContext,
  type Database,
  type Statement,
} from '../../packages/core/src/db/boundary.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { DailyProjection } from '../../packages/core/src/projections/daily.js';

export async function uxQueryPlans(
  sql: string,
  cookie: string,
  secret: string,
) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(sql);
    const adapter = sqliteAdapter(db);
    const owner = await AccessContext.owner(
      adapter,
      await sha256(cookie.split('.')[0]!),
      new Date().toISOString(),
    );
    const statements: { sql: string; values: (string | number | null)[] }[] =
      [];
    const measured: Database = {
      prepare(sql) {
        const capture = { sql, values: [] as (string | number | null)[] };
        statements.push(capture);
        const wrap = (query: Statement): Statement => ({
          bind(...values) {
            capture.values = values;
            return wrap(query.bind(...values));
          },
          first: query.first.bind(query),
          all: query.all.bind(query),
          run: query.run.bind(query),
        });
        return wrap(adapter.prepare(sql));
      },
      batch: adapter.batch.bind(adapter),
    };
    const result = await new DailyProjection(measured, owner).day(
      { date: '2026-10-05', timezone: 'Europe/Warsaw', limit: 20 },
      secret,
      new Date(),
    );
    const plans = statements.map((statement) =>
      db
        .prepare('EXPLAIN QUERY PLAN ' + statement.sql)
        .all(...statement.values)
        .map((row) => row.detail),
    );
    if (
      statements.length !== 4 ||
      result.counts.items !== 10000 ||
      result.items.length !== 20
    )
      throw new Error('UX_QUERY_BOUND_FAILED');
    if (
      db.prepare('PRAGMA foreign_key_check').all().length ||
      db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
    )
      throw new Error('UX_FIXTURE_INTEGRITY_FAILED');
    return {
      engine:
        'independent offline SQLite EXPLAIN of actual DailyProjection SQL; Worker latency measured separately',
      queries: statements.length,
      page_rows: result.items.length,
      counts: result.counts,
      plans,
      rows_read: null,
      rows_read_status: 'LOCAL_D1_RUNTIME_NOT_EXPOSED',
    };
  } finally {
    db.close();
  }
}
