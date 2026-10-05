// Minimal Cloudflare Gate E read-only snapshot. Never executes SQL or mutations.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  admitD1AnalyticsRead,
  admitMetadataRead,
  D1_ACCOUNT_DAILY_USAGE_QUERY,
} from './metadata-admission.ts';

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const config = JSON.parse(
  await (
    await import('node:fs/promises')
  ).readFile('config/defaults.json', 'utf8'),
);
if (config.paid_services_enabled !== false)
  throw new Error('PAID_POLICY_DENIED');
if (!/^[a-f0-9]{32}$/i.test(account ?? '')) throw new Error('ACCOUNT_REQUIRED');
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
const auth = spawnSync(
  process.execPath,
  [wrangler, 'auth', 'token', '--json'],
  {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  },
);
let token;
try {
  const result = JSON.parse(auth.stdout);
  if (
    auth.status === 0 &&
    result.type === 'oauth' &&
    typeof result.token === 'string'
  )
    token = result.token;
} catch {
  // Never emit CLI output or OAuth token.
}
if (!token) throw new Error('CLOUDFLARE_OAUTH_UNAVAILABLE');

const pseudonym = (value) =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);
const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
const now = new Date();
const sampled_at = now.toISOString();
const observations = [];
async function get(service, url, summarize) {
  try {
    const response = await fetch(url, {
      ...admitMetadataRead(url, account, config.paid_services_enabled),
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
    observations.push({
      service,
      http_status: response.status,
      content_type: response.headers.get('content-type'),
      json_shape:
        data && typeof data === 'object' ? Object.keys(data).sort() : null,
      evidence: response.ok && data ? summarize(data) : null,
    });
    return response.ok ? data : null;
  } catch {
    observations.push({
      service,
      http_status: null,
      outcome: 'UNAVAILABLE',
      evidence: null,
    });
    return null;
  }
}

const d1 = await get('cloudflare-d1-list', `${base}/d1/database`, (data) => ({
  success: data.success === true,
  database_count: Array.isArray(data.result) ? data.result.length : null,
  databases: (Array.isArray(data.result) ? data.result : []).map((row) => ({
    pseudonym: pseudonym(row.uuid ?? row.name ?? 'unknown'),
    size_bytes: typeof row.file_size === 'number' ? row.file_size : null,
  })),
}));
const listed = Array.isArray(d1?.result) ? d1.result : [];
for (const row of listed) {
  if (typeof row.uuid !== 'string' || !/^[a-f0-9-]{36}$/i.test(row.uuid))
    continue;
  // The detail endpoint has only a fields allowlist in this runner; avoid query ambiguity.
  const safeUrl = `${base}/d1/database/${row.uuid}`;
  const detail = await get('cloudflare-d1-detail', safeUrl, (data) => ({
    success: data.success === true,
    database_pseudonym: pseudonym(data.result?.uuid ?? row.uuid),
    size_bytes:
      typeof data.result?.file_size === 'number' ? data.result.file_size : null,
    jurisdiction: ['eu', 'fedramp', 'us'].includes(data.result?.jurisdiction)
      ? data.result.jurisdiction
      : null,
    read_replication: ['auto', 'disabled'].includes(
      data.result?.read_replication?.mode,
    )
      ? data.result.read_replication.mode
      : null,
  }));
  void detail;
  void url;
}

const date = sampled_at.slice(0, 10);
const analyticsQuery = {
  query: D1_ACCOUNT_DAILY_USAGE_QUERY,
  variables: { accountTag: account, start: date, end: date },
};
try {
  const admitted = admitD1AnalyticsRead(
    'https://api.cloudflare.com/client/v4/graphql',
    account,
    analyticsQuery,
    config.paid_services_enabled,
  );
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    ...admitted,
    headers,
    body: JSON.stringify(analyticsQuery),
    signal: AbortSignal.timeout(20000),
  });
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  const groups = data?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups;
  observations.push({
    service: 'cloudflare-d1-daily-usage',
    http_status: response.status,
    content_type: response.headers.get('content-type'),
    json_shape:
      data && typeof data === 'object' ? Object.keys(data).sort() : null,
    evidence:
      response.ok && Array.isArray(groups)
        ? {
            period: date,
            row_read_count: groups.length
              ? groups.reduce((sum, row) => sum + (row.sum?.rowsRead ?? 0), 0)
              : null,
            row_written_count: groups.length
              ? groups.reduce((sum, row) => sum + (row.sum?.rowsWritten ?? 0), 0)
              : null,
            usage_observed: groups.length > 0,
            groups: groups.length,
          }
        : null,
  });
} catch {
  observations.push({
    service: 'cloudflare-d1-daily-usage',
    http_status: null,
    outcome: 'UNAVAILABLE',
    evidence: null,
  });
}

await get('cloudflare-queues-list', `${base}/queues`, (data) => ({
  success: data.success === true,
  queue_count: Array.isArray(data.result) ? data.result.length : null,
}));
await get(
  'cloudflare-worker-account-settings',
  `${base}/workers/account-settings`,
  (data) => ({
    success: data.success === true,
    default_usage_model: data.result?.default_usage_model ?? null,
  }),
);
await get(
  'cloudflare-worker-scripts-list',
  `${base}/workers/scripts`,
  (data) => ({
    success: data.success === true,
    script_count: Array.isArray(data.result) ? data.result.length : null,
  }),
);

const evidence = {
  sampled_at,
  mode: 'read-only',
  account_pseudonym: `cf-${pseudonym(account)}`,
  paid_services_enabled: false,
  oauth_token_exported: false,
  external_mutations: 0,
  observations,
};
const output = `${JSON.stringify(evidence, null, 2)}\n`;
for (const secret of [token, account, process.env.CLOUDFLARE_API_TOKEN])
  if (secret && output.includes(secret))
    throw new Error('SECRET_IN_EVIDENCE_DENIED');
writeFileSync(
  'docs/verification/gate-e/cloudflare-service-readonly.json',
  output,
);
token = undefined;
console.log(
  JSON.stringify({
    result: 'RECORDED',
    observations: observations.map(({ service, http_status }) => ({
      service,
      http_status,
    })),
  }),
);
