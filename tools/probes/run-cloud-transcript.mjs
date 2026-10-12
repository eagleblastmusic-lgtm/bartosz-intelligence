import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import ts from 'typescript';
if (process.argv.length !== 3 || process.argv[2] !== '--verified-free-preview')
  throw new Error('VERIFIED_FREE_PREVIEW_REQUIRED');
process.loadEnvFile('.env');
const defaults = JSON.parse(readFileSync('config/defaults.json', 'utf8'));
if (
  defaults.paid_services_enabled !== false ||
  !/^[a-f0-9]{32}$/.test(process.env.CLOUDFLARE_ACCOUNT_ID ?? '')
)
  throw new Error('FREE_POLICY_REQUIRED');
const token = randomBytes(32).toString('base64url');
mkdirSync('.local/transcript-probe', { recursive: true });
mkdirSync('docs/verification/daily-workflow', { recursive: true });
const parsed = ts.parseConfigFileTextToJson(
  'wrangler.transcript.jsonc',
  readFileSync('tools/probes/wrangler.transcript.jsonc', 'utf8'),
);
if (parsed.error) throw new Error('INVALID_PROBE_CONFIG');
const config = parsed.config;
const configPath = resolve('.local/transcript-probe/wrangler.json');
config.main = resolve('tools/probes/transcript-worker.ts');
config.account_id = process.env.CLOUDFLARE_ACCOUNT_ID;
config.vars = { PROBE_TOKEN: token };
writeFileSync(configPath, JSON.stringify(config, null, 2));
const childEnvironment = { CI: 'true', WRANGLER_SEND_METRICS: 'false' };
for (const [key, value] of Object.entries(process.env))
  if (
    value &&
    [
      'PATH',
      'SYSTEMROOT',
      'TEMP',
      'TMP',
      'HOME',
      'USERPROFILE',
      'LOCALAPPDATA',
      'APPDATA',
      'COMSPEC',
      'SYSTEMDRIVE',
      'WINDIR',
    ].includes(key.toUpperCase())
  )
    childEnvironment[key] = value;
const receipt = {
  observed_at: new Date().toISOString(),
  environment: 'ACTUAL_CLOUDFLARE_REMOTE_PREVIEW',
  billing_basis:
    'Workers Free Active observed in authenticated Billing/Subscriptions UI',
  production_deployment: false,
  production_sql: 0,
  drive_writes: 0,
  ai_requests: 0,
  paid_services_activated: false,
  maximum_probe_invocations: 1,
};
const child = spawn(
  process.execPath,
  [
    resolve('node_modules/wrangler/bin/wrangler.js'),
    'dev',
    '--remote',
    '--config',
    configPath,
    '--port',
    '8799',
  ],
  {
    env: childEnvironment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let output = '',
  finished = false;
child.stdout.on('data', (chunk) => {
  output += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  output += chunk.toString();
});
child.on('close', () => {
  finished = true;
});
child.on('error', () => {
  finished = true;
});
try {
  const until = Date.now() + 120000;
  while (
    !/Ready on http:\/\/127\.0\.0\.1:8799/.test(output) &&
    !finished &&
    Date.now() < until
  )
    await new Promise((r) => setTimeout(r, 500));
  if (finished || !/Ready on http:\/\/127\.0\.0\.1:8799/.test(output)) {
    receipt.state = 'PENDING_OWNER_ACTION';
    receipt.reason = /Authentication|not authenticated|login|token/i.test(
      output,
    )
      ? 'CLOUDFLARE_PREVIEW_AUTH_REQUIRED'
      : 'CLOUDFLARE_REMOTE_PREVIEW_NOT_READY';
    receipt.compiler_failure =
      /Build failed|Could not resolve|ERROR.*build/i.test(output);
  } else {
    const response = await fetch('http://127.0.0.1:8799/probe', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      receipt.state = 'BLOCKED';
      receipt.http_status = response.status;
      receipt.reason = 'CLOUDFLARE_PROBE_RUNTIME_REJECTED';
    } else {
      const result = await response.json();
      if (
        result.runtime !== 'CLOUDFLARE_REMOTE' ||
        typeof result.colo !== 'string'
      )
        throw new Error('REMOTE_EXECUTION_NOT_PROVEN');
      writeFileSync(
        '.local/transcript-probe/private-result.json',
        JSON.stringify(result, null, 2) + '\n',
      );
      const { segments, ...metadata } = result;
      receipt.result = metadata;
      if (Array.isArray(segments) && result.status === 'OK') {
        const text = segments.map((s) => s.text).join('\n');
        receipt.returned_text_integrity =
          createHash('sha256').update(text).digest('hex') ===
          result.source_sha256;
        const cached = readFileSync(
          '.local/transcripts/rUhllpnYWR8.md',
          'utf8',
        );
        const expected =
          /SHA-256 pozyskanego tekstu \(kolejne cue połączone LF\): ([a-f0-9]{64})/.exec(
            cached,
          )?.[1];
        receipt.cached_reference_sha256 = expected ?? null;
        receipt.matches_cached_complete_source =
          expected === result.source_sha256;
        receipt.state =
          receipt.returned_text_integrity &&
          receipt.matches_cached_complete_source
            ? 'POC_SOURCE_MATCH'
            : 'BLOCKED';
      } else {
        receipt.state = 'BLOCKED';
        receipt.reason = result.reason ?? result.status;
      }
    }
  }
} catch (error) {
  receipt.state = 'PENDING_OWNER_ACTION';
  receipt.reason =
    error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : 'REMOTE_PREVIEW_TRANSPORT_OR_READBACK_HOLD';
} finally {
  child.kill('SIGINT');
}
// Wrangler diagnostics can contain ephemeral preview credentials. Never emit
// them or commit them. Only the fixed categories above leave this process.
writeFileSync(
  'docs/verification/daily-workflow/cloudflare-transcript-poc-' +
    receipt.observed_at.replaceAll(':', '-').replaceAll('.', '-') +
    '.json',
  JSON.stringify(receipt, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify(receipt));
