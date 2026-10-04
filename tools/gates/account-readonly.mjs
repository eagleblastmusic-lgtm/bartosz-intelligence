// Gate E metadata only. No generation, checkout, resource mutation or token export.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { admitMetadataRead } from './metadata-admission.ts';

const out = 'docs/verification/gate-e';
const sampled_at = new Date().toISOString();
const pseudonym = (value) =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);
const observations = [];
const policy = JSON.parse(readFileSync('config/defaults.json', 'utf8'));
async function read(service, url, headers, summarize) {
  const admitted = admitMetadataRead(
    url,
    process.env.CLOUDFLARE_ACCOUNT_ID,
    policy.paid_services_enabled,
  );
  const started = performance.now();
  try {
    const response = await fetch(url, {
      ...admitted,
      headers,
      signal: AbortSignal.timeout(20000),
    });
    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    const row = {
      service,
      sampled_at,
      http_status: response.status,
      latency_ms: Math.round(performance.now() - started),
      bytes: Buffer.byteLength(raw),
      outcome: response.ok ? 'ACCESS_OBSERVED' : 'ACCESS_DENIED',
      evidence: response.ok && data ? summarize(data) : null,
    };
    observations.push(row);
  } catch {
    observations.push({
      service,
      sampled_at,
      outcome: 'UNAVAILABLE',
      http_status: null,
      evidence: null,
    });
  }
}
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const cli = resolve('node_modules/wrangler/bin/wrangler.js');
let oauth;
try {
  const result = spawnSync(process.execPath, [cli, 'auth', 'token', '--json'], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  if (result.status === 0) {
    const parsed = JSON.parse(result.stdout);
    if (parsed.type === 'oauth' && typeof parsed.token === 'string')
      oauth = parsed.token;
  }
  // Raw CLI output never goes to logs, disk or evidence.
} catch {
  /* Unknown auth fails closed below. */
}
if (account && /^[a-f0-9]{32}$/i.test(account) && oauth) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  const headers = { Authorization: `Bearer ${oauth}` };
  await read(
    'cloudflare-subscriptions',
    `${base}/subscriptions`,
    headers,
    (data) => ({
      success: data.success === true,
      plans: (Array.isArray(data.result) ? data.result : []).map((row) => ({
        id: row.rate_plan?.id ?? null,
        name: row.rate_plan?.public_name ?? null,
        price: row.price ?? row.rate_plan?.price ?? null,
        currency: row.currency ?? row.rate_plan?.currency ?? null,
        state: row.state ?? null,
      })),
    }),
  );
  await read(
    'cloudflare-worker-account-settings',
    `${base}/workers/account-settings`,
    headers,
    (data) => ({
      success: data.success === true,
      default_usage_model: data.result?.default_usage_model ?? null,
    }),
  );
  await read('cloudflare-d1-list', `${base}/d1/database`, headers, (data) => ({
    success: data.success === true,
    database_count: Array.isArray(data.result) ? data.result.length : null,
    databases: (Array.isArray(data.result) ? data.result : []).map((row) => ({
      pseudonym: pseudonym(row.uuid ?? row.name ?? 'unknown'),
      size_bytes: row.file_size ?? null,
    })),
  }));
  await read('cloudflare-queues-list', `${base}/queues`, headers, (data) => ({
    success: data.success === true,
    queue_count: Array.isArray(data.result) ? data.result.length : null,
  }));
  await read(
    'cloudflare-worker-scripts-list',
    `${base}/workers/scripts`,
    headers,
    (data) => ({
      success: data.success === true,
      script_count: Array.isArray(data.result) ? data.result.length : null,
    }),
  );
}
oauth = undefined;
// YouTube Data API is quota metered, without a paid automatic request route.
// Key stays in a header; no key in request URL, diagnostics or response evidence.
if (process.env.YOUTUBE_API_KEY)
  await read(
    'youtube-data-api',
    'https://www.googleapis.com/youtube/v3/videos?part=id&id=TyGkMeECZJA',
    { 'x-goog-api-key': process.env.YOUTUBE_API_KEY },
    (data) => ({
      item_count: Array.isArray(data.items) ? data.items.length : null,
      actual_quota_limit: null,
      actual_quota_remaining: null,
      key_project_binding_verified: false,
    }),
  );
// Gemini API calls are denied until actual purpose and account billing are eligible.
const report = {
  sampled_at,
  mode: 'read-only',
  config_paid_services_enabled: policy.paid_services_enabled,
  account_pseudonym: account ? `cf-${pseudonym(account)}` : null,
  google_project:
    process.env.GOOGLE_PROJECT_ID === 'bartosz-intelligence'
      ? 'bartosz-intelligence'
      : 'OTHER_OR_UNKNOWN',
  cloudflare_auth_mode: observations.some((row) =>
    row.service.startsWith('cloudflare'),
  )
    ? 'oauth'
    : 'UNAVAILABLE',
  credential_presence: {
    cloudflare_account: Boolean(account),
    cloudflare_api_token: Boolean(process.env.CLOUDFLARE_API_TOKEN),
    youtube_api_key: Boolean(process.env.YOUTUBE_API_KEY),
    gemini_api_key: Boolean(process.env.GEMINI_API_KEY),
  },
  observations,
  provider_generation_submissions: 0,
  gemini: {
    gate: 'INCONCLUSIVE',
    requests: 0,
    region: 'PL/EEA',
    purpose: 'see dashboard-observations.json and owner clarification',
    billing: 'see dashboard-observations.json',
    quota: 'see dashboard-observations.json',
  },
  result: 'INCONCLUSIVE',
};
const text = `${JSON.stringify(report, null, 2)}\n`;
for (const secret of [
  process.env.YOUTUBE_API_KEY,
  process.env.GEMINI_API_KEY,
  process.env.CLOUDFLARE_API_TOKEN,
])
  if (secret && text.includes(secret))
    throw new Error('SECRET_IN_EVIDENCE_DENIED');
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/account-readonly.json`, text);
console.log(
  JSON.stringify({
    result: report.result,
    observations: observations.map((row) => ({
      service: row.service,
      http_status: row.http_status,
      outcome: row.outcome,
    })),
    generation_submissions: 0,
  }),
);
