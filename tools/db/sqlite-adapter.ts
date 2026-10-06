import type {
  Database,
  Statement,
} from '../../packages/core/src/db/boundary.js';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
// Offline administrative adapter: batches are real independent SQLite transactions.
export function sqliteAdapter(sqlite: DatabaseSync): Database {
  const query = (sql: string, values: SQLInputValue[] = []): Statement => ({
    bind(...bound) {
      return query(sql, bound);
    },
    async first<T>(column?: string) {
      const row = sqlite.prepare(sql).get(...values);
      return (row ? (column ? row[column] : row) : null) as T | null;
    },
    async all<T>() {
      return { results: sqlite.prepare(sql).all(...values) as T[] };
    },
    async run() {
      const prepared = sqlite.prepare(sql);
      if (prepared.columns().length) {
        const results = prepared.all(...values);
        const changes = sqlite.prepare('SELECT changes() n').get()!.n;
        return { meta: { changes: Number(changes) }, results };
      }
      const result = prepared.run(...values);
      return { meta: { changes: Number(result.changes) } };
    },
  });
  return {
    prepare: query,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
