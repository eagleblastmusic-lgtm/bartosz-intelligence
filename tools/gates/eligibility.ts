import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
} from 'node:fs';
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
  | 'NOT_RUN'
  | 'UNAVAILABLE'
  | 'ACCESS_OBSERVED_ACCOUNT_UNSELECTED'
  | 'ACCESS_OBSERVED_ACCOUNT_SELECTED'
  | 'UNKNOWN' = 'NOT_RUN';
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
    if (result.status === 0) {
      try {
        const identity = JSON.parse(result.stdout) as {
          loggedIn?: boolean;
          accounts?: { id: string }[];
        };
        if (
          identity.loggedIn &&
          identity.accounts?.some(
            (account) => account.id === process.env.CLOUDFLARE_ACCOUNT_ID,
          )
        )
          auth = 'ACCESS_OBSERVED_ACCOUNT_SELECTED';
      } catch {
        auth = 'UNKNOWN';
      }
    }
  } else auth = 'UNAVAILABLE';
}
const dashboardPath = resolve(output, 'dashboard-observations.json');
const dashboard = existsSync(dashboardPath)
  ? (JSON.parse(readFileSync(dashboardPath, 'utf8')) as {
      result?: string;
      blockers?: string[];
      cloudflare?: { plan?: string };
      google?: { billing?: string; project?: string };
      gemini?: { tier?: string };
      drive?: { active?: boolean };
    })
  : null;
const ownerPath = resolve(output, 'owner-use-decision.json');
const owner = existsSync(ownerPath)
  ? (JSON.parse(readFileSync(ownerPath, 'utf8')) as {
      owner_use_classification?: string;
      developer_is_only_user?: boolean;
      public_or_other_user_distribution?: boolean;
      billing_route?: string;
      paid_services_enabled?: boolean;
    })
  : null;
const ownerClassified =
  owner?.owner_use_classification === 'professional_single_owner' &&
  owner.developer_is_only_user === true &&
  owner.public_or_other_user_distribution === false &&
  owner.billing_route === 'disabled' &&
  owner.paid_services_enabled === false;
const probePath = resolve(output, 'gemini-probe.json');
const probe = existsSync(probePath)
  ? (JSON.parse(readFileSync(probePath, 'utf8')) as {
      result?: string;
      http_status?: number;
      reason?: string;
      retry_required?: boolean;
    })
  : null;
const cloudflareSnapshotPath = resolve(
  output,
  'cloudflare-service-readonly.json',
);
const cloudflareSnapshot = existsSync(cloudflareSnapshotPath)
  ? (JSON.parse(readFileSync(cloudflareSnapshotPath, 'utf8')) as {
      sampled_at?: string;
      observations?: { service: string; http_status: number | null }[];
    })
  : null;
const reservationPath = resolve(output, 'gemini-probe-reservation.json');
const reservation = existsSync(reservationPath)
  ? (JSON.parse(readFileSync(reservationPath, 'utf8')) as {
      generation_requests_total?: number;
    })
  : null;
const probeFailed = probe?.result === 'FAIL';
const probePassed = probe?.result === 'PASS';
const probeTemporary = probe?.result === 'TEMPORARY_FAILURE';
const probeIncomplete = probe?.result === 'INCOMPLETE';
const probeInconclusive = probe?.result === 'INCONCLUSIVE';
const requiredSnapshotChecksPassed =
  dashboard?.cloudflare?.plan === 'Workers Free' &&
  dashboard?.google?.billing === 'DISABLED' &&
  dashboard?.google?.project === 'bartosz-intelligence' &&
  dashboard?.gemini?.tier === 'Free tier' &&
  ownerClassified &&
  probePassed &&
  cloudflareSnapshot?.observations?.length &&
  cloudflareSnapshot.observations.every((item) => item.http_status === 200);
function gateForService(service: string): string {
  if (service === 'gemini') {
    if (probePassed) return 'PASS';
    if (probeFailed) return 'FAIL';
    if (probeTemporary) return 'TEMPORARY_FAILURE';
    if (probeIncomplete) return 'INCOMPLETE';
    if (probeInconclusive) return 'INCONCLUSIVE';
    return 'NOT_RUN';
  }
  if (service === 'youtube-data-api')
    return dashboard?.google?.project === 'bartosz-intelligence' &&
      credentials.YOUTUBE_API_KEY
      ? 'ACCOUNT_PROBE_PASS'
      : 'INCONCLUSIVE';
  if (service === 'cloudflare-workers')
    return dashboard?.cloudflare?.plan === 'Workers Free'
      ? 'ACCOUNT_ELIGIBILITY_PASS_RUNTIME_NOT_DEPLOYED'
      : 'INCONCLUSIVE';
  if (service === 'cloudflare-assets')
    return dashboard?.cloudflare?.plan === 'Workers Free'
      ? 'ACCOUNT_ELIGIBILITY_PASS_LOCAL_RUNTIME_NOT_DEPLOYED'
      : 'INCONCLUSIVE';
  if (service === 'cloudflare-d1' || service === 'cloudflare-queues')
    return cloudflareSnapshot?.observations?.some(
      (item) =>
        item.service.includes(service.replace('cloudflare-', '')) &&
        item.http_status === 200,
    )
      ? 'ACCOUNT_ELIGIBILITY_PASS_NO_PROJECT_RESOURCE'
      : 'INCONCLUSIVE';
  return 'NOT_RUN';
}
const report = {
  mode: values.mode,
  sampled_at: new Date().toISOString(),
  result:
    values.mode === 'dry-run'
      ? 'NOT_RUN'
      : probeFailed
        ? 'FAIL'
        : probeTemporary || probeIncomplete
          ? 'INCOMPLETE'
          : probeInconclusive
            ? 'INCONCLUSIVE'
            : probePassed &&
                dashboard?.drive?.active === false &&
                requiredSnapshotChecksPassed
              ? 'PASS'
              : 'INCONCLUSIVE',
  paid_services_enabled: false,
  network_submissions: 0,
  provider_generation_submissions: reservation?.generation_requests_total ?? 0,
  account_metadata_read: { cloudflare_auth: auth, cli_exit_code: authExit },
  credential_presence_only: credentials,
  snapshots: [],
  owner_use_classification: ownerClassified
    ? 'professional_single_owner'
    : null,
  gemini_live_probe: probe,
  account_evidence_refs:
    values.mode === 'account'
      ? [
          'account-readonly.json',
          ...(cloudflareSnapshot ? ['cloudflare-service-readonly.json'] : []),
          ...(dashboard ? ['dashboard-observations.json'] : []),
          ...(ownerClassified ? ['owner-use-decision.json'] : []),
          ...(probe
            ? ['gemini-probe.json', 'gemini-probe-reservation.json']
            : []),
        ]
      : [],
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
    free_eligible:
      service === 'cloudflare-workers' ||
      service === 'cloudflare-d1' ||
      service === 'cloudflare-queues' ||
      service === 'cloudflare-assets'
        ? dashboard?.cloudflare?.plan === 'Workers Free'
          ? 'PASS'
          : 'UNKNOWN'
        : service === 'gemini'
          ? dashboard?.google?.billing === 'DISABLED' &&
            dashboard?.gemini?.tier === 'Free tier' &&
            ownerClassified
            ? 'PASS'
            : 'UNKNOWN'
          : service === 'youtube-data-api'
            ? credentials.YOUTUBE_API_KEY &&
              dashboard?.google?.project === 'bartosz-intelligence'
              ? 'PASS'
              : 'UNKNOWN'
            : 'UNKNOWN',
    production_enabled: false,
    gate: gateForService(service),
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
            : auth === 'ACCESS_OBSERVED_ACCOUNT_SELECTED'
              ? []
              : ['CLOUDFLARE_ACCOUNT_SELECTION_REQUIRED']),
          ...(
            dashboard?.blockers ?? [
              'ACCOUNT_QUOTA_BILLING_AND_PURPOSE_PROOF_REQUIRED',
            ]
          )
            .filter(
              (blocker) =>
                !(
                  cloudflareSnapshot &&
                  blocker ===
                    'CLOUDFLARE_D1_QUEUES_ASSETS_USAGE_LIMITS_AND_LIVE_PROBES_NOT_QUALIFIED'
                ),
            )
            .filter(
              (blocker) =>
                !(
                  ownerClassified &&
                  blocker ===
                    'GEMINI_EEA_SINGLE_OWNER_API_CLIENT_ELIGIBILITY_UNRESOLVED'
                ),
            ),
          ...(probeFailed
            ? [
                probe.http_status === 200
                  ? 'GEMINI_STRUCTURED_OUTPUT_VALIDATION_FAILED'
                  : `GEMINI_LIVE_PROBE_FAILED_${probe.http_status ?? 'TRANSPORT'}`,
              ]
            : []),
          ...(probeInconclusive && probe?.http_status === 503
            ? ['GEMINI_LIVE_PROBE_INCONCLUSIVE_UPSTREAM_HTTP_503']
            : []),
          ...(probeTemporary
            ? [
                `GEMINI_LIVE_PROBE_TEMPORARY_HTTP_${probe?.http_status ?? 'UNKNOWN'}_RETRY_REQUIRED`,
              ]
            : []),
          ...(probeIncomplete && probe?.retry_required
            ? ['GEMINI_LIVE_PROBE_INCOMPLETE_OUTPUT_RETRY_REQUIRED']
            : []),
          ...(probePassed ? [] : ['GEMINI_LIVE_FUNCTIONAL_PROBE_NOT_PASSED']),
        ],
};
mkdirSync(output, { recursive: true });
const previous = resolve(output, 'account-preflight.json');
if (values.mode === 'account' && existsSync(previous)) {
  const prior = JSON.parse(readFileSync(previous, 'utf8')) as {
    sampled_at: string;
  };
  const historical = resolve(
    output,
    `account-preflight-${prior.sampled_at.replaceAll(':', '-')}.json`,
  );
  if (!existsSync(historical)) copyFileSync(previous, historical);
}
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
    provider_generation_submissions: report.provider_generation_submissions,
    blockers: report.blockers,
  }),
);
if (values.mode === 'account') process.exitCode = 2;
