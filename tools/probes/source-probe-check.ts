/** Ten sam izolowany test przenośny w Node na Windows i Linux ARM64. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { liveProbe, offlineProbe } from './source-probe.js';
const root = resolve(process.argv[2] ?? '.');
const panel = await readFile(
  resolve(root, 'tests/fixtures/source-probe/panel-segments.json'),
  'utf8',
);
const srt = await readFile(
  resolve(root, 'tests/fixtures/source-probe/same-cues.srt'),
  'utf8',
);
const source = {
  video: 'aircAruvnKk',
  operation: 'offline',
  format: 'panel-segments',
} as const;
const checks = [];
const one = await offlineProbe(source, panel, { format: 'srt', body: srt });
const two = await offlineProbe(source, panel, { format: 'srt', body: srt });
assert.deepEqual({ ...one, elapsed_ms: 0 }, { ...two, elapsed_ms: 0 });
assert.equal(one.levels.MATCHES_AVAILABLE_REFERENCE, true);
assert.equal(one.levels.INDEPENDENTLY_CONFIRMED_COMPLETE, false);
checks.push('REPEATABLE_EXACT_FIXTURE_MATCH_WITHOUT_COMPLETE_CLAIM');
const partial = JSON.parse(panel);
partial.segments.pop();
assert.equal(
  (
    await offlineProbe(source, JSON.stringify(partial), {
      format: 'srt',
      body: srt,
    })
  ).category,
  'PARTIAL_RESPONSE',
);
checks.push('STRUCTURALLY_VALID_PREFIX_REJECTED_BY_REFERENCE');
const wrongReference = JSON.parse(panel);
wrongReference.video_id = 'IHZwWFHWa-w';
const wrongIdentity = await offlineProbe(source, panel, {
  format: 'panel-segments',
  body: JSON.stringify(wrongReference),
});
assert.equal(wrongIdentity.category, 'INVALID_INPUT');
assert.equal(wrongIdentity.levels.MATCHES_AVAILABLE_REFERENCE, null);
checks.push('WRONG_VIDEO_REFERENCE_REJECTED');
let requests = 0;
const refusal = await liveProbe(
  { video: source.video, operation: 'oembed' },
  {
    fetch: async () => {
      requests++;
      return new Response('PRIVATE_SIGNED_URL_COOKIE_TOKEN', { status: 403 });
    },
  },
);
assert.equal(refusal.category, 'SOURCE_REFUSED');
assert.equal(requests, 1);
assert.equal(
  JSON.stringify(refusal).includes('PRIVATE_SIGNED_URL_COOKIE_TOKEN'),
  false,
);
checks.push('SINGLE_REFUSAL_WITHOUT_RETRY_OR_LOG_LEAK');
const controller = new AbortController();
const pending = liveProbe(
  { video: source.video, operation: 'oembed' },
  {
    signal: controller.signal,
    fetch: async (_url, options) =>
      new Promise<Response>((_done, reject) => {
        options!.signal!.addEventListener(
          'abort',
          () => reject(new Error('PRIVATE_TOKEN')),
          { once: true },
        );
      }),
  },
);
controller.abort();
assert.equal((await pending).category, 'CANCELLED');
checks.push('PENDING_OPERATION_STOPPED');
const blocked = await liveProbe(
  { video: source.video, operation: 'supadata-native' },
  {
    fetch: async () => {
      throw new Error('NETWORK_MUST_NOT_RUN');
    },
  },
);
assert.equal(blocked.request_count, 0);
assert.equal(blocked.category, 'NO_AUTHORIZED_ACCESS');
checks.push('NO_ACCESS_NO_REQUEST');
process.stdout.write(
  JSON.stringify({
    schema: 'source-probe-portable-check:1',
    runtime: process.version,
    system: process.platform,
    architecture: process.arch,
    checks,
    pass: true,
    actual_network_requests: 0,
    production_d1_calls: 0,
  }) + '\n',
);
