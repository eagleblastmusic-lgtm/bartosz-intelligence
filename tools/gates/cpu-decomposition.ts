import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  extractPlayerResponse,
  readLimited,
  sha256Bytes,
} from './adapters/direct-captions-core.js';

// CPU attribution experiment, NOT a Gate 0 video observation or platform PASS.
// Same byte count as first refusal response; synthetic public fixture only.
const size = 1_316_765;
const player = JSON.stringify({
  playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Zaloguj się' },
  responseContext: {},
});
const prefix = `<script>var ytInitialPlayerResponse = ${player};</script>`;
const html = prefix + ' '.repeat(size - Buffer.byteLength(prefix));
const encoded = new TextEncoder().encode(html);
const stages: Record<
  string,
  { cpu_us: number; wall_ms: number; iterations: number }
> = {};
async function measure(
  name: string,
  work: () => unknown | Promise<unknown>,
  iterations = 40,
) {
  await work();
  const cpu = process.cpuUsage();
  const wall = performance.now();
  for (let i = 0; i < iterations; i++) await work();
  const delta = process.cpuUsage(cpu);
  stages[name] = {
    cpu_us: (delta.user + delta.system) / iterations,
    wall_ms: (performance.now() - wall) / iterations,
    iterations,
  };
}
await measure('body_read_64k_chunks', async () => {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= encoded.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoded.subarray(offset, offset + 65536));
      offset += 65536;
    },
  });
  await readLimited(new Response(stream), 5 * 1024 * 1024);
});
await measure('body_read_1k_chunks', async () => {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= encoded.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoded.subarray(offset, offset + 1024));
      offset += 1024;
    },
  });
  await readLimited(new Response(stream), 5 * 1024 * 1024);
});
await measure('sha256_raw_response', () => sha256Bytes(encoded));
await measure('utf8_decode', () => new TextDecoder().decode(encoded));
await measure('player_extract_and_json_parse', () =>
  extractPlayerResponse(html),
);
await measure('result_serialization', () =>
  JSON.stringify({
    status: 'AUTH_REQUIRED',
    bytes: size,
    shape: ['playabilityStatus', 'responseContext'],
  }),
);
writeFileSync(
  'docs/verification/gate-0/cpu-decomposition-local.json',
  JSON.stringify(
    {
      experiment: 'synthetic refusal-path component decomposition',
      measured_at: new Date().toISOString(),
      runtime: process.version,
      cpu_source: 'process.cpuUsage user+system; isolated sequential process',
      input_bytes: size,
      upstream_requests: 0,
      stages,
      limits:
        'Local CPU is not Cloudflare CPU. Original platform invocation has no phase profiler; exact 62ms attribution cannot be reconstructed from aggregate metrics. Network excluded by synthetic stream; body processing includes stream dispatch and copies.',
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify(stages));
