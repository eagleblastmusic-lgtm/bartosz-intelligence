import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { d1Analytics } from './cloudflare.mjs';
import { d1UsagePolicy, type UsageSample } from './d1-usage-policy.js';

const local = process.argv[3] === '--local';
if (!(
  (process.argv.length === 3 || (process.argv.length === 4 && local)) &&
  process.argv[2] === '--read-analytics'
))
  throw new Error('EXPLICIT_ANALYTICS_READ_REQUIRED');
const now = new Date(),
  day = now.toISOString().slice(0, 10);
const deployment = JSON.parse(readFileSync('config/deployment.json', 'utf8'));
const receipt: Record<string, unknown> = {
  version: 'D1UsageAnalytics/1.0',
  observed_at: now.toISOString(),
  start_utc: day + 'T00:00:00.000Z',
  end_utc: now.toISOString(),
  state: 'UNKNOWN',
  scope: 'ALL_ACCOUNT_DATABASES',
  sql_queries_executed: 0,
  account_rows_read: null,
  account_rows_written: null,
  current_storage_bytes: null,
  paid_services_enabled: false,
};
try {
  const accounts = await d1Analytics(
    `query D1Quota($accountTag: string, $filter: ZoneWorkersRequestsFilter_InputObject) {
    viewer { accounts(filter: {accountTag: $accountTag}) {
      d1AnalyticsAdaptiveGroups(limit: 1000, filter: $filter, orderBy: [datetimeHour_ASC]) {
        sum { readQueries writeQueries rowsRead rowsWritten }
        dimensions { datetimeHour databaseId }
      }
    } }
  }`,
    {
      filter: {
        AND: [
          {
            datetimeHour_geq: day + 'T00:00:00.000Z',
            datetimeHour_leq: now.toISOString(),
          },
        ],
      },
    },
  );
  const rows = accounts[0]?.d1AnalyticsAdaptiveGroups;
  if (!Array.isArray(rows) || !rows.length || rows.length >= 1000)
    throw new Error('D1_ANALYTICS_EMPTY_OR_TRUNCATED');
  const hourly = rows.map((row) => {
    const r = row as {
      sum: Record<string, number>;
      dimensions: { datetimeHour: string; databaseId: string };
    };
    if (
      !Number.isFinite(Date.parse(r.dimensions.datetimeHour)) ||
      ['readQueries', 'writeQueries', 'rowsRead', 'rowsWritten'].some(
        (key) => !Number.isFinite(r.sum[key]) || r.sum[key]! < 0,
      )
    )
      throw new Error('D1_ANALYTICS_INVALID');
    return {
      hour_utc: r.dimensions.datetimeHour,
      database:
        r.dimensions.databaseId === deployment.database_id
          ? 'BARTOSZ_CORE'
          : 'OTHER_' +
            createHash('sha256')
              .update(r.dimensions.databaseId)
              .digest('hex')
              .slice(0, 12),
      ...r.sum,
      rowsRead: r.sum.rowsRead!,
      rowsWritten: r.sum.rowsWritten!,
    };
  });
  Object.assign(receipt, {
    state: 'MEASURED_ANALYTICS',
    account_rows_read: hourly.reduce((n, r) => n + r.rowsRead!, 0),
    account_rows_written: hourly.reduce((n, r) => n + r.rowsWritten!, 0),
    hourly,
    analytics_lag: 'NOT_MEASURED_NOT_EXACT_REMAINING_QUOTA',
  });
} catch (error) {
  const code = error instanceof Error ? error.message : '';
  receipt.reason = /^D1_ANALYTICS_[A-Z_0-9]+$/.test(code)
    ? code
    : 'D1_ANALYTICS_FAILED';
}
const policy = d1UsagePolicy(receipt as unknown as UsageSample, now);
receipt.policy = policy;
const directory = local ? '.local/d1-usage' : 'docs/verification/release';
const output =
  directory + '/d1-analytics-' + day + '-' + randomUUID() + '.json';
mkdirSync(directory, { recursive: true });
writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(
  JSON.stringify(
    local
      ? { state: receipt.state, policy, evidence: output }
      : { ...receipt, evidence: output },
  ),
);
if (local)
  writeFileSync(
    directory + '/latest.json',
    JSON.stringify(receipt, null, 2) + '\n',
  );
if (receipt.state === 'UNKNOWN') process.exitCode = 2;
