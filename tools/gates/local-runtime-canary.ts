import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { probeDirectCaptions } from './adapters/direct-captions-core.js';

const path = 'docs/verification/gate-0/local-runtime-canary.json';
if (existsSync(path)) throw new Error('CANARY_ALREADY_RESERVED_NO_RETRY');
const manifest = JSON.parse(
  readFileSync('docs/verification/gate-0/MANIFEST.json', 'utf8'),
) as { sha256: string };
const phases: Record<
  string,
  { cpu_us: number; wall_ms: number; cpu_resolution_note: string }
> = {};
const starts = new Map<string, { cpu: NodeJS.CpuUsage; wall: number }>();
let requests = 0;
const boundedFetch: typeof fetch = async (input, init) => {
  requests++;
  if (requests > 2) throw new Error('CANARY_REQUEST_BOUND');
  return fetch(input, { ...init, signal: AbortSignal.timeout(60000) });
};
const record: Record<string, unknown> = {
  started_at: new Date().toISOString(),
  runtime: process.version,
  measurement_ref: 'cpu-retest-platform.json',
  provider: 'DirectCaptionsLocal',
  manifest_sha256: manifest.sha256,
  provider_sha256: createHash('sha256')
    .update(readFileSync('tools/gates/adapters/direct-captions-core.ts'))
    .digest('hex'),
  paid_services_enabled: false,
  billing_route: 'disabled',
  control_plane: 'Cloudflare Free unchanged',
  purpose: 'bounded local recovery canary, not full Gate 0 PASS',
  status: 'RESERVED',
  upstream_request_limit: 2,
};
writeFileSync(path, JSON.stringify(record, null, 2));
const initialCpu = process.cpuUsage();
const wall = performance.now();
const result = await probeDirectCaptions(
  {
    video_id: 'uEztHu4NHrs',
    request_id: 'local-runtime-canary-1',
    language_code: 'en',
    kind: 'manual',
    duration_seconds: 792,
  },
  boundedFetch,
  (name, event) => {
    if (event === 'start')
      starts.set(name, { cpu: process.cpuUsage(), wall: performance.now() });
    else {
      const start = starts.get(name)!;
      const delta = process.cpuUsage(start.cpu);
      phases[name] = {
        cpu_us: delta.user + delta.system,
        wall_ms: performance.now() - start.wall,
        cpu_resolution_note:
          'Windows scheduler accounting is coarse; 0 is below resolution, not zero work',
      };
    }
  },
);
const total = process.cpuUsage(initialCpu);
Object.assign(record, {
  completed_at: new Date().toISOString(),
  status: 'MEASURED',
  actual_upstream_requests: requests,
  result,
  phases,
  total_cpu_us: total.user + total.system,
  total_wall_ms: performance.now() - wall,
  eligibility:
    'Existing owner computer and pinned Node; no external billing or account required; not yet production enabled',
  limits:
    '8ms/10ms remain unchanged for ordinary edge invocations. Local compute measurements do not grant edge PASS. Whole-corpus two-window and source fidelity qualification still required.',
});
writeFileSync(path, JSON.stringify(record, null, 2) + '\n');
console.log(
  JSON.stringify({
    source_status: result.status,
    reason: result.reason_code,
    requests,
    total_cpu_us: record.total_cpu_us,
    total_wall_ms: record.total_wall_ms,
    phases,
  }),
);
