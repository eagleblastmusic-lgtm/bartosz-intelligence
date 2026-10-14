/** Tests the existing client with a harmless exec fixture; never a Snap proof. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (key) => {
  const index = process.argv.indexOf(key);
  return index < 0 ? undefined : process.argv[index + 1];
};
const root = resolve(arg('--root') ?? '.');
const out = resolve(arg('--output') ?? '.local/browser-isolation/cdp-contract');
const documentGuard = process.argv.includes('--document-guard');
const playerState = process.argv.includes('--player-state');
const sessionCookies = process.argv.includes('--session-cookies');
assert(
  [documentGuard, playerState, sessionCookies].filter(Boolean).length <= 1,
  'SELECT_ONE_FOCUSED_MODE',
);
await mkdir(out, { recursive: false });
const bundle = resolve(
  arg('--client-bundle') ?? join(out, 'client-contract.mjs'),
);
if (!arg('--client-bundle')) {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('tsx/package.json'))(
    'esbuild',
  );
  const built = await build({
    stdin: {
      contents:
        "export { captureNative } from './tools/transcript-engine/browser.ts'; export { makeReference, makePanel, controlSnapshot } from './tools/transcript-engine/check.ts'; export { EngineFailure } from './tools/transcript-engine/engine.ts';",
      resolveDir: root,
      sourcefile: 'architecture-client-contract.ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile: bundle,
    metafile: true,
  });
  assert(
    !Object.keys(built.metafile.inputs).some((p) =>
      /apps\/|workers\/|\/db\//.test(p),
    ),
  );
  await writeFile(
    join(out, 'build.json'),
    JSON.stringify(
      {
        inputs: Object.keys(built.metafile.inputs),
        bundle_sha256: createHash('sha256')
          .update(await readFile(bundle))
          .digest('hex'),
      },
      null,
      2,
    ) + '\n',
  );
}
const {
  captureNative,
  makeReference,
  makePanel,
  controlSnapshot,
  EngineFailure,
} = await import(pathToFileURL(bundle).href);
const reference = await makeReference(root, 'aircAruvnKk');
const snapshot = controlSnapshot('aircAruvnKk');
const dom = {
  ok: true,
  segments: reference.segments.map((c) => ({
    text: c.text,
    start: Math.floor(c.start_ms / 1000),
  })),
};
const panel = JSON.stringify(makePanel(reference.segments));
const records = [],
  trackedKeys = [
    'TEMP',
    'TMP',
    'TMPDIR',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'PYTHONPATH',
    'NODE_OPTIONS',
    'CLOUDFLARE_API_TOKEN',
  ];
const original = Object.fromEntries(
  trackedKeys.map((key) => [key, process.env[key]]),
);
const realSpawn = childProcess.spawn;
const sockets = new Set();
let server,
  spawnCount = 0,
  activeSpec;
// Windows cannot directly exec a POSIX wrapper. Its test-only spawn adapter
// preserves the real stdio/env options and invokes Node + the harmless fixture.
if (process.platform === 'win32') {
  childProcess.spawn = (executable, argv, options) => {
    assert.equal(executable, activeSpec.wrapper);
    spawnCount++;
    return realSpawn(
      process.execPath,
      [
        join(here, 'harmless-cdp-fixture.mjs'),
        `--fixture-config=${activeSpec.config}`,
        ...argv,
      ],
      options,
    );
  };
  syncBuiltinESMExports();
}
try {
  const jobs = join(
    out,
    'home',
    'bartosz-browser',
    'snap',
    'chromium',
    'common',
    'jobs',
  );
  await mkdir(jobs, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = jobs;
  assert.equal(resolve(tmpdir()), resolve(jobs));
  for (const key of trackedKeys.slice(3))
    process.env[key] = 'OTE_SYNTHETIC_FORBIDDEN_VALUE';
  let watchRequests = 0,
    transcriptRequests = 0;
  server = createServer((req, res) => {
    if (req.url === '/watch?v=aircAruvnKk') {
      watchRequests++;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        '<!doctype html><script id="ote-replay-data" type="application/json">' +
          JSON.stringify({ snapshot, dom }).replace(/</g, '\\u003c') +
          '</script>',
      );
    } else if (
      req.url === '/youtubei/v1/get_transcript' &&
      req.method === 'POST'
    ) {
      transcriptRequests++;
      res.setHeader('content-type', 'application/json');
      res.end(panel);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const scenarios = sessionCookies
    ? ['session-cookies']
    : playerState
      ? ['player-login-without-id']
      : documentGuard
        ? [
            'auth-iframe401',
            'requested-watch401',
            'requested-watch403',
            'requested-watch429',
            'other-video401',
          ]
        : ['complete', 'timeout', 'cancel'];
  for (const scenario of scenarios) {
    const expectedCategory =
      {
        timeout: 'TIMEOUT',
        cancel: 'CANCELLED',
        'requested-watch401': 'AUTH_REQUIRED',
        'requested-watch403': 'SOURCE_REFUSED',
        'requested-watch429': 'RATE_LIMITED',
        'player-login-without-id': 'AUTH_REQUIRED',
      }[scenario] ?? 'NONE';
    const receipt = join(out, `${scenario}-fixture.json`),
      config = join(out, `${scenario}-config.json`);
    const wrapper = join(out, `${scenario}-exec-wrapper`);
    activeSpec = { wrapper, config };
    await writeFile(
      config,
      JSON.stringify({
        scenario:
          documentGuard || playerState || sessionCookies
            ? scenario
            : scenario === 'complete'
              ? 'complete'
              : 'stall',
        origin,
        jobs,
        receipt,
      }),
    );
    const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
    await writeFile(
      wrapper,
      '#!/bin/sh\nexec ' +
        [
          process.execPath,
          join(here, 'harmless-cdp-fixture.mjs'),
          `--fixture-config=${config}`,
        ]
          .map(quote)
          .join(' ') +
        ' "$@"\n',
    );
    await chmod(wrapper, 0o700);
    const d = {},
      controller = new AbortController();
    const cancel =
      scenario === 'cancel'
        ? setTimeout(() => controller.abort(), 2000)
        : undefined;
    let category = 'NONE',
      failureCode = null;
    try {
      const result = await captureNative({
        executable: wrapper,
        video: 'aircAruvnKk',
        timeoutMs: scenario === 'timeout' ? 3000 : 20000,
        replayOrigin: origin,
        signal: controller.signal,
        diagnostics: d,
        ...(sessionCookies
          ? {
              maxPageRequests: 128,
              sessionCookies: [
                {
                  name: 'OTE_SYNTHETIC_SESSION',
                  value: 'OTE_SYNTHETIC_COOKIE_VALUE_NEVER_LOG',
                  domain: '.youtube.com',
                  path: '/',
                  secure: true,
                  httpOnly: true,
                },
              ],
            }
          : {}),
        domReaderPath: join(
          root,
          'tools/firefox-transcript-v0.4.2/candidate-v0.4.2/panel-reader.js',
        ),
      });
      assert.equal(expectedCategory, 'NONE');
      assert.deepEqual(result.snapshot, snapshot);
      assert.deepEqual(result.dom, dom);
      assert.equal(result.body, panel);
      assert.equal(d.transport_complete, true);
    } catch (e) {
      assert(e instanceof EngineFailure);
      category = e.category;
      failureCode = e.code;
      assert.equal(category, expectedCategory);
      if (documentGuard)
        assert.equal(e.code, 'WATCH_HTTP_' + scenario.slice(-3));
      if (playerState) assert.equal(e.code, 'PLAYER_LOGIN_REQUIRED_WITHOUT_ID');
    } finally {
      if (cancel) clearTimeout(cancel);
    }
    const fixture = JSON.parse(await readFile(receipt, 'utf8'));
    if (sessionCookies) {
      assert.equal(fixture.session_cookies_injected, true);
      assert(
        fixture.methods.indexOf('Network.enable') <
          fixture.methods.indexOf('Network.setCookies'),
      );
      assert(
        fixture.methods.indexOf('Network.setCookies') <
          fixture.methods.indexOf('Page.navigate'),
      );
      assert(
        !JSON.stringify(d).includes('OTE_SYNTHETIC_COOKIE_VALUE_NEVER_LOG'),
      );
      assert(
        !JSON.stringify(fixture).includes(
          'OTE_SYNTHETIC_COOKIE_VALUE_NEVER_LOG',
        ),
      );
      const before = spawnCount;
      await assert.rejects(
        captureNative({
          executable: wrapper,
          video: 'aircAruvnKk',
          timeoutMs: 1000,
          diagnostics: {},
          domReaderPath: 'unused',
          sessionCookies: [
            {
              name: 'OTE_SYNTHETIC_SESSION',
              value: 'test',
              domain: '.google.com',
            },
          ],
        }),
        (e) => e.code === 'SESSION_COOKIE_INVALID',
      );
      assert.equal(spawnCount, before);
    }
    if (playerState) {
      assert.deepEqual(d.player_state, {
        video_id: null,
        playability_status: 'LOGIN_REQUIRED',
        reason: 'Sign in to confirm you’re not a bot',
        subreason: 'This helps protect our community. Learn more',
        tracks_explicit: false,
        track_count: 0,
      });
      assert.equal(d.snapshot, undefined);
      assert.equal(d.transcript_requests, 0);
      assert(!fixture.methods.includes('Network.getResponseBody'));
    }
    if (documentGuard) {
      assert.equal(fixture.document_responses.length, 1);
      assert.equal(
        fixture.document_responses[0].status,
        Number(scenario.slice(-3)),
      );
    }
    assert.equal(d.profile_removed, true);
    assert.equal(d.sandbox, true);
    assert.equal(fixture.foreign_request_rejected, true);
    assert(
      fixture.methods.includes('Browser.getVersion') &&
        fixture.methods.includes('Target.getTargets'),
    );
    await assert.rejects(access(fixture.profile));
    assert.throws(() => process.kill(fixture.pid, 0));
    records.push({
      scenario,
      status: 'PASS_CLIENT_CONTRACT_ONLY',
      category,
      pid_exited: true,
      profile_removed: true,
      pipe_fds: [3, 4],
      original_text_count:
        expectedCategory === 'NONE' ? reference.segments.length : null,
      emulated_dom: true,
      ...(sessionCookies
        ? {
            cookies_injected_before_navigation: true,
            foreign_cookie_rejected_before_launch: true,
            cookie_values_absent_from_diagnostics: true,
          }
        : {}),
      ...(playerState
        ? {
            failure_code: failureCode,
            player_state: d.player_state,
            transcript_requests: d.transcript_requests,
          }
        : {}),
    });
  }
  if (!documentGuard && !playerState && !sessionCookies) {
    const before = spawnCount;
    await assert.rejects(
      captureNative({
        executable: activeSpec.wrapper,
        video: 'aircAruvnKk',
        timeoutMs: 1000,
        allowNoSandbox: true,
        diagnostics: {},
        domReaderPath: 'unused',
      }),
      (e) => e.code === 'LIVE_REQUIRES_BROWSER_SANDBOX',
    );
    assert.equal(spawnCount, before);
  }
  assert.equal(
    watchRequests,
    sessionCookies || playerState ? 1 : documentGuard ? 5 : 3,
  );
  assert.equal(transcriptRequests, playerState ? 0 : documentGuard ? 2 : 1);
  const result = {
    schema: 'ote-browser-architecture-cdp-contract:1',
    status: 'PASS_CLIENT_CONTRACT_ONLY',
    platform: process.platform,
    arch: process.arch,
    test_count: sessionCookies ? 2 : playerState ? 1 : documentGuard ? 5 : 4,
    focused_document_guard: documentGuard,
    focused_player_state: playerState,
    focused_session_cookies: sessionCookies,
    transport: 'ASCIIZ_JSON_FD3_FD4',
    entrypoint:
      process.platform === 'win32'
        ? 'WINDOWS_TEST_ONLY_SPAWN_ADAPTER'
        : 'ACTUAL_POSIX_EXEC_WRAPPER',
    source: 'SAVED_REAL_TEXTS_RECONSTRUCTED_ENVELOPE_EMULATED_CDP_DOM',
    accepted: false,
    snap_executions: 0,
    chromium_executions: 0,
    live_youtube_requests: 0,
    loopback_watch_requests: watchRequests,
    loopback_transcript_requests: transcriptRequests,
    records,
  };
  await writeFile(
    join(out, 'result.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify(result) + '\n');
} finally {
  childProcess.spawn = realSpawn;
  syncBuiltinESMExports();
  for (const key of trackedKeys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise((done) => server.close(() => done()));
  // Preserve receipts and wrapper/config as evidence; captureNative removes its own profiles.
}
