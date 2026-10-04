import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  loadConfig,
  ProviderRegistry,
} from '../../packages/core/src/config/index.js';
import defaults from '../../config/defaults.json' with { type: 'json' };

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'dry-run' },
    output: { type: 'string', default: 'docs/verification/gate-e' },
  },
});
if (!['dry-run', 'account'].includes(values.mode))
  throw new Error('GATE_E_MODE_INVALID');
loadConfig(defaults, new ProviderRegistry([]));
const output = resolve(values.output);
if (
  !output.startsWith(
    `${resolve('docs/verification')}${process.platform === 'win32' ? '\\' : '/'}`,
  )
)
  throw new Error('EVIDENCE_OUTPUT_OUTSIDE_VERIFICATION');
const names = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'GOOGLE_PROJECT_ID',
  'YOUTUBE_API_KEY',
  'GEMINI_API_KEY',
] as const;
const credentials = Object.fromEntries(
  names.map((name) => [name, Boolean(process.env[name])]),
);
let auth:
  'NOT_RUN' | 'UNAVAILABLE' | 'ACCESS_OBSERVED_ACCOUNT_UNSELECTED' | 'UNKNOWN' =
  'NOT_RUN';
let authExit: number | null = null;
if (values.mode === 'account') {
  // Official CLI keeps OAuth credentials in its own store. Never export/cache tokens.
  const cli = resolve('node_modules/wrangler/bin/wrangler.js');
  if (existsSync(cli)) {
    const result = spawnSync(process.execPath, [cli, 'whoami', '--json'], {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
    authExit = result.status;
    // Account names, emails, IDs and raw stderr are deliberately discarded.
    auth =
      result.status === 0
        ? 'ACCESS_OBSERVED_ACCOUNT_UNSELECTED'
        : result.status === null
          ? 'UNKNOWN'
          : 'UNAVAILABLE';
  } else auth = 'UNAVAILABLE';
}
const report = {
  mode: values.mode,
  sampled_at: new Date().toISOString(),
  result: values.mode === 'dry-run' ? 'NOT_RUN' : 'INCONCLUSIVE',
  paid_services_enabled: false,
  network_submissions: 0,
  account_metadata_read: { cloudflare_auth: auth, cli_exit_code: authExit },
  credential_presence_only: credentials,
  snapshots: [],
  services: [
    'cloudflare-workers',
    'cloudflare-d1',
    'cloudflare-queues',
    'cloudflare-assets',
    'youtube-data-api',
    'gemini',
  ].map((service) => ({
    service,
    active_baseline_required: true,
    free_eligible: 'UNKNOWN',
    gate: 'NOT_RUN',
  })),
  drive: {
    active: false,
    gate: 'UNAVAILABLE',
    reason: 'NO_AUTHORIZED_ACCOUNT_STORAGE_API_SNAPSHOT',
  },
  blockers:
    values.mode === 'dry-run'
      ? []
      : [
          ...(auth === 'UNAVAILABLE'
            ? ['CLOUDFLARE_AUTH_REQUIRED']
            : ['CLOUDFLARE_ACCOUNT_SELECTION_AND_FREE_BILLING_PROOF_REQUIRED']),
          'GOOGLE_PROJECT_QUOTA_AND_BILLING_PROOF_REQUIRED',
          'GEMINI_REGION_PURPOSE_MODEL_FREE_ELIGIBILITY_REQUIRED',
          'LIVE_SERVICE_PROBES_AND_USAGE_EVIDENCE_NOT_RUN',
        ],
};
mkdirSync(output, { recursive: true });
writeFileSync(
  resolve(
    output,
    values.mode === 'dry-run' ? 'dry-run.json' : 'account-preflight.json',
  ),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    result: report.result,
    cloudflare_auth: auth,
    network_submissions: 0,
    blockers: report.blockers,
  }),
);
if (values.mode === 'account') process.exitCode = 2;
