/** Harmless protocol fixture, not Chromium, Snap or a JavaScript DOM engine. */
import { createReadStream, writeSync } from 'node:fs';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve, relative, isAbsolute } from 'node:path';

const specArg = process.argv.find((a) => a.startsWith('--fixture-config='));
assert(specArg, 'FIXTURE_CONFIG_REQUIRED');
const spec = JSON.parse(
  await readFile(specArg.split('=').slice(1).join('='), 'utf8'),
);
const args = process.argv.slice(process.argv.indexOf(specArg) + 1);
assert(args.includes('--remote-debugging-pipe'));
assert(
  !args.some((a) =>
    /^--(?:no-sandbox|disable.*sandbox|remote-debugging-port)(?:=|$)/.test(a),
  ),
);
const profiles = args.filter((a) => a.startsWith('--user-data-dir='));
assert.equal(profiles.length, 1);
const profile = profiles[0].split('=').slice(1).join('=');
const withinJobs = relative(resolve(spec.jobs), resolve(profile));
assert(withinJobs && !withinJobs.startsWith('..') && !isAbsolute(withinJobs));
const profileStat = await stat(profile);
if (process.platform !== 'win32') assert.equal(profileStat.mode & 0o777, 0o700);
const forbidden = [
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'PYTHONPATH',
  'NODE_OPTIONS',
  'CLOUDFLARE_API_TOKEN',
];
const environmentPresence = Object.fromEntries(
  forbidden.map((k) => [k, k in process.env]),
);
assert(Object.values(environmentPresence).every((v) => v === false));
const record = {
  schema: 'ote-harmless-cdp-fixture:1',
  pid: process.pid,
  profile,
  args,
  environment_presence: environmentPresence,
  methods: [],
  http_requests: [],
  document_responses: [],
  foreign_request_rejected: false,
  dom_emulated: true,
  browser_executions: 0,
  session_cookies_injected: false,
};
const save = async () => {
  await writeFile(
    spec.receipt + '.tmp',
    JSON.stringify(record, null, 2) + '\n',
  );
  await rename(spec.receipt + '.tmp', spec.receipt);
};
await save();
let buffer = Buffer.alloc(0),
  location = 'about:blank',
  page,
  body;
const pendingRequests = new Map();
const send = (message) => {
  const bytes = Buffer.from(JSON.stringify(message) + '\0');
  // Exercise actual PipeCdp framing across arbitrary chunk boundaries.
  writeSync(4, bytes.subarray(0, 7));
  writeSync(4, bytes.subarray(7));
};
const event = (method, params) =>
  send({ method, params, sessionId: 'fixture-session' });
const paused = (id, url, resourceType) => {
  pendingRequests.set(id, url);
  event('Fetch.requestPaused', {
    requestId: id,
    request: { url },
    resourceType,
  });
};
async function consume(id, url) {
  const parsed = new URL(url);
  assert.equal(
    parsed.origin,
    spec.origin,
    'FIXTURE_MUST_NEVER_FETCH_EXTERNAL_ORIGIN',
  );
  record.http_requests.push(parsed.pathname);
  const response = await fetch(url, {
    method: id === 'fixture-transcript' ? 'POST' : 'GET',
    signal: AbortSignal.timeout(2000),
  });
  const received = await response.text();
  if (id === 'fixture-watch') {
    location = url;
    // This decodes a controlled JSON block, not a browser DOM.
    const block = received.match(
      /<script id="ote-replay-data" type="application\/json">([\s\S]*?)<\/script>/,
    );
    assert(block, 'LOCAL_REPLAY_BLOCK_REQUIRED');
    page = JSON.parse(block[1]);
    if (spec.scenario === 'player-login-without-id')
      page.snapshot = {
        video_id: '',
        playability_status: 'LOGIN_REQUIRED',
        reason: 'Sign in to confirm you’re not a bot',
        subreason: 'This helps protect our community. Learn more',
        tracks_explicit: false,
        tracks: [],
        original_language: null,
      };
    if (
      spec.scenario === 'auth-iframe401' ||
      spec.scenario === 'other-video401' ||
      /^requested-watch(?:401|403|429)$/.test(spec.scenario)
    ) {
      const response = {
        url:
          spec.scenario === 'auth-iframe401'
            ? 'https://accounts.google.com/ServiceLogin'
            : spec.scenario === 'other-video401'
              ? `${spec.origin}/watch?v=zzzzzzzzzzz`
              : url,
        status: spec.scenario.startsWith('requested-watch')
          ? Number(spec.scenario.slice(-3))
          : 401,
      };
      record.document_responses.push(response);
      event('Network.responseReceived', {
        requestId: 'fixture-document-status',
        type: 'Document',
        response,
      });
    }
  } else {
    body = received;
    event('Network.responseReceived', {
      requestId: id,
      type: 'Fetch',
      response: { url, status: response.status },
    });
    event('Network.dataReceived', {
      requestId: id,
      dataLength: Buffer.byteLength(body),
    });
    event('Network.loadingFinished', { requestId: id });
  }
  await save();
}
async function handle(message) {
  record.methods.push(message.method);
  const reply = (result) => send({ id: message.id, result });
  switch (message.method) {
    case 'Browser.getVersion':
      reply({ product: 'HarmlessCDPFixture/1.0' });
      break;
    case 'Target.getTargets':
      reply({ targetInfos: [{ targetId: 'fixture-page', type: 'page' }] });
      break;
    case 'Target.attachToTarget':
      reply({ sessionId: 'fixture-session' });
      break;
    case 'Network.setCookies':
      assert.equal(spec.scenario, 'session-cookies');
      assert(record.methods.includes('Network.enable'));
      assert(!record.methods.includes('Page.navigate'));
      assert.deepEqual(message.params.cookies, [
        {
          name: 'OTE_SYNTHETIC_SESSION',
          value: 'OTE_SYNTHETIC_COOKIE_VALUE_NEVER_LOG',
          domain: '.youtube.com',
          path: '/',
          secure: true,
          httpOnly: true,
        },
      ]);
      // Retain only order/count proof, never cookie parameters.
      record.session_cookies_injected = true;
      reply({});
      break;
    case 'Page.navigate': {
      if (spec.scenario === 'session-cookies')
        assert(record.session_cookies_injected);
      assert.equal(message.params.url, `${spec.origin}/watch?v=aircAruvnKk`);
      reply({});
      paused('fixture-watch', message.params.url, 'Document');
      paused(
        'fixture-foreign',
        'https://example.invalid/never-requested',
        'Script',
      );
      break;
    }
    case 'Fetch.continueRequest': {
      const url = pendingRequests.get(message.params.requestId);
      pendingRequests.delete(message.params.requestId);
      reply({});
      await consume(message.params.requestId, url);
      break;
    }
    case 'Fetch.failRequest': {
      assert.equal(message.params.requestId, 'fixture-foreign');
      record.foreign_request_rejected = true;
      pendingRequests.delete(message.params.requestId);
      reply({});
      await save();
      break;
    }
    case 'Runtime.evaluate': {
      const expression = message.params.expression;
      let value;
      if (expression === 'location.href') value = location;
      else if (expression.includes('original_language:null'))
        value = page?.snapshot ?? null;
      else if (expression.includes('inner.length !== 1')) {
        value = { clicked: true, count: 1 };
        if (spec.scenario !== 'stall')
          paused(
            'fixture-transcript',
            `${spec.origin}/youtubei/v1/get_transcript`,
            'Fetch',
          );
      } else if (expression.includes('readTranscriptPanel(')) value = page.dom;
      else value = false;
      reply({ result: { value } });
      break;
    }
    case 'Network.getResponseBody':
      reply({ body, base64Encoded: false });
      break;
    case 'Browser.close':
      await save();
      reply({});
      setTimeout(() => process.exit(0), 20);
      break;
    default:
      reply({});
  }
}
let queue = Promise.resolve();
createReadStream('', { fd: 3, autoClose: false }).on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  assert(buffer.length <= 1024 * 1024, 'FIXTURE_MESSAGE_LIMIT');
  let end;
  while ((end = buffer.indexOf(0)) >= 0) {
    const message = JSON.parse(buffer.subarray(0, end).toString('utf8'));
    buffer = buffer.subarray(end + 1);
    queue = queue
      .then(() => handle(message))
      .catch((e) => {
        process.stderr.write(`FIXTURE_FAILURE:${e.message}\n`);
        process.exit(2);
      });
  }
});
