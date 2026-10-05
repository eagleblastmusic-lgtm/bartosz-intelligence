import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (
  !/^[a-f0-9]{32}$/i.test(account ?? '') ||
  JSON.parse(readFileSync('config/defaults.json', 'utf8'))
    .paid_services_enabled !== false
)
  throw new Error('FREE_ACCOUNT_CONFIGURATION_REQUIRED');
const result = spawnSync(
  process.execPath,
  [resolve('node_modules/wrangler/bin/wrangler.js'), 'auth', 'token', '--json'],
  {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  },
);
let credential;
try {
  const token = JSON.parse(result.stdout);
  if (
    result.status === 0 &&
    token.type === 'oauth' &&
    typeof token.token === 'string'
  )
    credential = token.token;
} catch {
  /* fail closed */
}
if (!credential) throw new Error('CLOUDFLARE_AUTH_REQUIRED');
let response;
try {
  response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`,
    {
      headers: { Authorization: `Bearer ${credential}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    },
  );
} catch {
  throw new Error('SUBDOMAIN_READ_FAILED');
}
credential = undefined;
const payload = await response.json();
if (
  !response.ok ||
  payload.success !== true ||
  !/^[a-z0-9][a-z0-9-]{0,62}$/.test(payload.result?.subdomain ?? '')
)
  throw new Error('SUBDOMAIN_UNAVAILABLE');
const app = {
  oauth_client_name: 'Bartosz Intelligence',
  worker_name: 'bartosz-intelligence',
  app_origin: `https://bartosz-intelligence.${payload.result.subdomain}.workers.dev`,
  auth_callback_path: '/api/v1/auth/callback',
  authorized_javascript_origins: [],
  sampled_at: new Date().toISOString(),
  origin_source: 'actual selected Cloudflare account workers subdomain',
  deployment_status: 'NOT_DEPLOYED',
  paid_services_enabled: false,
};
writeFileSync('config/application.json', JSON.stringify(app, null, 2) + '\n', {
  flag: 'wx',
});
console.log(JSON.stringify(app));
