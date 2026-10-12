import { mkdirSync, writeFileSync } from 'node:fs';
import { cf, remoteDatabase } from './cloudflare.mjs';
import {
  decryptDriveRefreshToken,
  importDriveWrappingKey,
} from '../../packages/core/src/drive/credentials.js';
import {
  DriveClient,
  DriveFailure,
} from '../../packages/core/src/drive/client.js';
import {
  canonicalTranscriptRoot,
  canonicalReportRoot,
} from '../../packages/contracts/src/daily-report.js';
import { boundedText } from '../../packages/core/src/http/bounded-text.js';
if (process.argv[2] !== '--read-only' || process.argv.length !== 3)
  throw new Error('READ_ONLY_AUDIT_REQUIRED');
const receipt: Record<string, unknown> = {
  observed_at: new Date().toISOString(),
  production_mutations: 0,
  drive_mutations: 0,
  ai_requests: 0,
  paid_services_activated: false,
};
try {
  const settings = (await cf('workers/account-settings')) as {
    default_usage_model?: unknown;
  };
  receipt.worker_account_settings = {
    default_usage_model: settings.default_usage_model ?? null,
  };
  let subscriptions: {
    rate_plan?: { id?: string; public_name?: string };
  }[] = [];
  try {
    subscriptions = (await cf('subscriptions')) as typeof subscriptions;
  } catch {
    receipt.subscription_read_status = 'NOT_AUTHORIZED';
  }
  receipt.subscriptions = Array.isArray(subscriptions)
    ? subscriptions.map((s) => ({
        id: s.rate_plan?.id,
        name: s.rate_plan?.public_name,
      }))
    : null;
  const versions = (await cf(
    'workers/scripts/bartosz-intelligence/deployments',
  )) as { deployments?: unknown };
  receipt.deployment_inventory_available = !!versions;
  const db = remoteDatabase();
  const row = await db
    .prepare(
      `SELECT c.owner_id,c.connection_id,c.account_subject,c.client_id,c.scopes_json,k.envelope_json FROM drive_connections c JOIN drive_credentials k USING(owner_id,connection_id) WHERE c.auth_state='CONNECTED' AND c.owner_id IN (SELECT owner_id FROM owner_users WHERE allowlisted=1) ORDER BY c.updated_at DESC LIMIT 1`,
    )
    .first<{
      owner_id: string;
      connection_id: string;
      account_subject: string;
      client_id: string;
      scopes_json: string;
      envelope_json: string;
    }>();
  receipt.schema_count = await db
    .prepare('SELECT COUNT(*) n FROM applied_migrations')
    .first<number>('n');
  if (
    !row ||
    !process.env.DRIVE_WRAPPING_KEY ||
    !process.env.DRIVE_WRAPPING_KEY_ID ||
    !process.env.GOOGLE_DRIVE_CLIENT_SECRET ||
    row.client_id !== process.env.GOOGLE_DRIVE_CLIENT_ID
  )
    throw new Error('DRIVE_AUDIT_AUTHORIZATION_REQUIRED');
  const wrapping = await importDriveWrappingKey(
      process.env.DRIVE_WRAPPING_KEY_ID,
      process.env.DRIVE_WRAPPING_KEY,
    ),
    refresh = await decryptDriveRefreshToken(
      JSON.parse(row.envelope_json),
      row,
      wrapping,
    );
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: row.client_id,
      client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('DRIVE_AUDIT_REFRESH_DENIED');
  }
  const grant = JSON.parse(await boundedText(response, 32768));
  const client = new DriveClient(grant.access_token);
  receipt.oauth_scopes = JSON.parse(row.scopes_json);
  const folders = [];
  for (const id of [canonicalTranscriptRoot, canonicalReportRoot]) {
    try {
      const file = await client.getFile(id),
        access = await client.inspectContentPermissions(id);
      folders.push({
        folder_id: id,
        mime_type: file.mimeType,
        trashed: file.trashed,
        writable: file.capabilities?.canAddChildren ?? null,
        ...access,
        status: access.private_owner_only
          ? 'PRIVATE'
          : 'BLOCKED_PUBLIC_OR_SHARED_CONTENT',
      });
    } catch (error) {
      folders.push({
        folder_id: id,
        status: 'BLOCKED',
        reason:
          error instanceof DriveFailure ? error.message : 'AUDIT_READ_FAILED',
      });
    }
  }
  receipt.folders = folders;
  receipt.state = 'READ_ONLY_AUDIT_COMPLETE';
} catch (error) {
  receipt.state = 'PENDING_OWNER_ACTION';
  receipt.reason =
    error instanceof Error && /^[A-Z_0-9]+$/.test(error.message)
      ? error.message
      : 'READ_ONLY_AUDIT_AUTH_OR_TRANSPORT_FAILED';
}
mkdirSync('docs/verification/daily-workflow', { recursive: true });
writeFileSync(
  'docs/verification/daily-workflow/production-readonly-' +
    String(receipt.observed_at).replaceAll(':', '-').replaceAll('.', '-') +
    '.json',
  JSON.stringify(receipt, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify(receipt));
