// Read-only platform telemetry capture. OAuth token and raw event payloads stay in memory.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
process.loadEnvFile('.env');
const defaults = JSON.parse(readFileSync('config/defaults.json', 'utf8'));
if (defaults.paid_services_enabled !== false)
  throw new Error('PAID_POLICY_DENIED');
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!/^[a-f0-9]{32}$/i.test(account ?? '')) throw new Error('ACCOUNT_REQUIRED');
const previewRuns = readFileSync(
  'docs/verification/gate-0/preview-runs.jsonl',
  'utf8',
)
  .trim()
  .split(/\r?\n/)
  .map(JSON.parse);
const preview = previewRuns.at(-1);
const auth = spawnSync(
  process.execPath,
  ['node_modules/wrangler/bin/wrangler.js', 'auth', 'token', '--json'],
  {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    env: {
      ...process.env,
      WRANGLER_WRITE_LOGS: 'false',
      WRANGLER_LOG_SANITIZE: 'true',
      WRANGLER_SEND_METRICS: 'false',
    },
  },
);
let token;
try {
  const data = JSON.parse(auth.stdout);
  if (auth.status === 0 && data.type === 'oauth') token = data.token;
} catch {}
if (typeof token !== 'string') throw new Error('OAUTH_UNAVAILABLE');
const rows = readFileSync('docs/verification/gate-0/results.jsonl', 'utf8')
  .trim()
  .split(/\r?\n/)
  .map(JSON.parse)
  .filter(
    (row) =>
      row.provider === 'DirectCaptionsEdge' &&
      row.window_local_time === preview.window.split('/')[1],
  );
const start =
  Math.min(...rows.map((row) => Date.parse(row.started_at))) - 60000;
const end =
  Math.max(...rows.map((row) => Date.parse(row.completed_at))) + 60000;
const query = {
  queryId: 'gate0-cpu-' + preview.preview_id,
  timeframe: { from: start, to: end },
  view: 'events',
  dry: true,
  limit: 2000,
  parameters: {
    datasets: ['cloudflare-workers'],
    filterCombination: 'and',
    filters: [
      {
        key: '$workers.preview.id',
        operation: 'eq',
        type: 'string',
        value: preview.preview_id,
      },
      { key: '$workers.cpuTimeMs', operation: 'exists', type: 'number' },
    ],
  },
};
const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(30000),
  },
);
const raw = await response.text();
let data;
try {
  data = JSON.parse(raw);
} catch {
  data = null;
}
const events = new Map();
const eventShapes = [];
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) visit(item);
    return;
  }
  const worker = value.$workers;
  if (worker && typeof worker.cpuTimeMs === 'number') {
    eventShapes.push({
      worker_keys: Object.keys(worker),
      metadata_keys: Object.keys(value.$metadata ?? {}),
    });
    if (worker.preview?.id === preview.preview_id) {
      const key =
        worker.requestId ?? value.$metadata?.requestId ?? value.$metadata?.id;
      if (typeof key === 'string')
        events.set(key, {
          platform_request_id: key,
          event_id: value.$metadata?.id ?? null,
          cpu_time_ms: worker.cpuTimeMs,
          wall_time_ms: worker.wallTimeMs ?? null,
          outcome: worker.outcome ?? null,
          preview_id: worker.preview.id,
          sample_interval:
            value.$metadata?.sampleInterval ?? value.sampleInterval ?? null,
        });
    }
  }
  for (const item of Object.values(value)) visit(item);
}
visit(data?.result);
const samples = [...events.values()];
const times = samples.map((event) => event.cpu_time_ms).sort((a, b) => a - b);
const evidence = {
  schema_version: 'gate0-platform-cpu-1.0',
  captured_at: new Date().toISOString(),
  source: 'Cloudflare Workers Preview Observability REST API',
  http_status: response.status,
  content_type: response.headers.get('content-type'),
  raw_response_sha256: createHash('sha256').update(raw).digest('hex'),
  response_shape: data ? Object.keys(data) : null,
  result_shape: data?.result ? Object.keys(data.result) : null,
  preview_id: preview.preview_id,
  preview_slug: preview.preview_slug,
  window: preview.window,
  timeframe: query.timeframe,
  expected_edge_invocations: rows.length,
  matched_unique_invocations: samples.length,
  cpu_p95_ms: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null,
  cpu_max_ms: times.at(-1) ?? null,
  observed_event_shapes: eventShapes.slice(0, 1),
  platform_events: samples,
  capture_status:
    response.ok && samples.length === rows.length ? 'CAPTURED' : 'INCONCLUSIVE',
  cpu_gate_status:
    response.ok && samples.length === rows.length
      ? times.at(-1) < 10 && times[Math.ceil(times.length * 0.95) - 1] <= 8
        ? 'PASS'
        : 'FAIL'
      : 'INCONCLUSIVE',
  sampling_note:
    'Compare matched unique invocation count to all recorded Edge calls; no wall-clock substitution.',
  api_error_codes: (data?.errors ?? [])
    .map((error) => error.code)
    .filter((code) => typeof code === 'number'),
};
writeFileSync(
  'docs/verification/gate-0/cpu-first-window.json',
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    ...evidence,
    platform_events: undefined,
    observed_event_shapes: undefined,
  }),
);
