import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const app = JSON.parse(readFileSync('config/application.json', 'utf8'));
if (
  app.paid_services_enabled !== false ||
  process.env.APP_ORIGIN !== app.app_origin
)
  throw new Error('FREE_ORIGIN_REQUIRED');
const result = spawnSync(
  process.execPath,
  [
    resolve('node_modules/wrangler/bin/wrangler.js'),
    'deploy',
    '--config',
    'apps/api/wrangler.production.json',
    '--secrets-file',
    '.local/deployment-secrets.json',
  ],
  {
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  },
);
if (result.status !== 0) {
  mkdirSync('.local', { recursive: true });
  // Persist only numeric API error codes, never raw CLI diagnostics or credential-bearing requests.
  const codes = [...(result.stderr ?? '').matchAll(/\[code:\s*(\d+)\]/g)].map(
    (match) => match[1],
  );
  writeFileSync(
    '.local/deployment-error-redacted.log',
    JSON.stringify({ exit_code: result.status, api_error_codes: codes }) + '\n',
  );
  throw new Error('DEPLOYMENT_FAILED_' + (result.status ?? 'TIMEOUT'));
}
const match = result.stdout.match(/Current Version ID:\s*([a-f0-9-]{36})/i);
const evidence = {
  deployed_at: new Date().toISOString(),
  app_origin: app.app_origin,
  version_id: match?.[1] ?? null,
  paid_services_enabled: false,
  credential_values_recorded: false,
};
mkdirSync('docs/verification/deployment', { recursive: true });
writeFileSync(
  'docs/verification/deployment/' +
    evidence.deployed_at.replaceAll(':', '-') +
    '.json',
  JSON.stringify(evidence, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify(evidence));
