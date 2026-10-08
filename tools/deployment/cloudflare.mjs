import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { cloudflareRequest } from './cloudflare-request.mjs';
export const account = process.env.CLOUDFLARE_ACCOUNT_ID;
let credential;
function loadCredential(refresh = false) {
  const options = {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
  };
  if (refresh) {
    // Official whoami invokes Wrangler's login/refresh path. Capture its entire
    // output; user metadata and credential-bearing diagnostics are never logged.
    const check = spawnSync(
      process.execPath,
      [resolve('node_modules/wrangler/bin/wrangler.js'), 'whoami', '--json'],
      options,
    );
    if (check.status !== 0) throw new Error('CLOUDFLARE_AUTH_REFRESH_REQUIRED');
  }
  const result = spawnSync(
    process.execPath,
    [
      resolve('node_modules/wrangler/bin/wrangler.js'),
      'auth',
      'token',
      '--json',
    ],
    options,
  );
  try {
    const value = JSON.parse(result.stdout);
    if (
      result.status === 0 &&
      value.type === 'oauth' &&
      typeof value.token === 'string' &&
      /^[\x21-\x7e]{1,8192}$/.test(value.token)
    )
      return value.token;
  } catch {
    /* fail closed */
  }
  throw new Error('CLOUDFLARE_AUTH_REQUIRED');
}
export async function cf(path, method = 'GET', body) {
  if (!/^[a-f0-9]{32}$/i.test(account ?? ''))
    throw new Error('ACCOUNT_CONFIGURATION_REQUIRED');
  credential ??= loadCredential();
  const result = await cloudflareRequest(
    account,
    credential,
    path,
    method,
    body,
    () => loadCredential(true),
  );
  credential = result.credential;
  return result.result;
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
