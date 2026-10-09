import type { Database } from '../../packages/core/src/db/boundary.js';
export const account: string | undefined;
export function cf(
  path: string,
  method?: string,
  body?: unknown,
): Promise<unknown>;
export function d1Analytics(
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>[]>;
interface Query {
  sql: string;
  params: (string | number | null)[];
}
interface Result<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
  meta: {
    changes: number;
    rows_read?: number;
    rows_written?: number;
    size_after?: number;
  };
}
export function query<T = Record<string, unknown>>(
  sql: string,
  params?: Query['params'],
): Promise<Result<T>[]>;
export function queryBatch(batch: Query[]): Promise<Result[]>;
export function remoteDatabase(execute?: typeof queryBatch): Database;
