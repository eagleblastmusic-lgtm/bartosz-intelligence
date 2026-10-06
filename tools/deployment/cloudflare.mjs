import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
export const account = process.env.CLOUDFLARE_ACCOUNT_ID;
let credential;
export async function cf(path, method = 'GET', body) {
  if (!/^[a-f0-9]{32}$/i.test(account ?? ''))
    throw new Error('ACCOUNT_CONFIGURATION_REQUIRED');
  if (!credential) {
    const result = spawnSync(
      process.execPath,
      [
        resolve('node_modules/wrangler/bin/wrangler.js'),
        'auth',
        'token',
        '--json',
      ],
      {
        encoding: 'utf8',
        timeout: 20000,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      },
    );
    try {
      const value = JSON.parse(result.stdout);
      if (result.status === 0 && value.type === 'oauth')
        credential = value.token;
    } catch {
      /* fail closed */
    }
    if (!credential) throw new Error('CLOUDFLARE_AUTH_REQUIRED');
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    },
  );
  const value = await response.json();
  if (!response.ok || value.success !== true)
    throw new Error(
      `CLOUDFLARE_REQUEST_FAILED_${response.status}_${value.errors?.[0]?.code ?? 'UNKNOWN'}`,
    );
  return value.result;
}
export async function query(sql, params = []) {
  return queryBatch([{ sql, params }]);
}
export async function queryBatch(batch) {
  const { readFileSync } = await import('node:fs');
  const deployment = JSON.parse(readFileSync('config/deployment.json', 'utf8'));
  const result = await cf(
    `d1/database/${deployment.database_id}/query`,
    'POST',
    { batch },
  );
  if (result.some((row) => row.success !== true))
    throw new Error('REMOTE_QUERY_FAILED');
  return result;
}
// Administrative bridge to the existing Core repositories. SQL and bound
// values remain separate; a repository batch is one official D1 REST batch.
export function remoteDatabase(execute = queryBatch) {
  class RemoteStatement {
    constructor(sql, params = []) {
      this.sql = sql;
      this.params = params;
    }
    bind(...params) {
      return new RemoteStatement(this.sql, params);
    }
    async result() {
      return (await execute([{ sql: this.sql, params: this.params }]))[0];
    }
    async first(column) {
      const row = (await this.result()).results[0] ?? null;
      return column && row ? row[column] : row;
    }
    async all() {
      return { results: (await this.result()).results };
    }
    async run() {
      return { meta: (await this.result()).meta };
    }
  }
  return {
    prepare: (sql) => new RemoteStatement(sql),
    batch: async (statements) =>
      execute(statements.map(({ sql, params }) => ({ sql, params }))),
  };
}
