import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { queryBatch, remoteDatabase } from './cloudflare.mjs';
import { d1TestBudget } from './d1-test-budget.js';
import { d1UsagePolicy, type UsageSample } from './d1-usage-policy.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { DriveClient } from '../../packages/core/src/drive/client.js';
import { importDriveWrappingKey } from '../../packages/core/src/drive/credentials.js';
import { refreshDriveAccess } from '../../packages/core/src/drive/oauth.js';
import { provisionTranscriptFolder } from '../../packages/core/src/transcript/archive-folder.js';
import { TranscriptDriveArchive } from '../../packages/core/src/transcript/archive.js';
import defaults from '../../config/defaults.json';
import ledger from '../../db/migration-ledger.json';
import { ArtifactRepository } from '../../packages/core/src/artifacts/store.js';
import {
  renderTranscriptArchive,
  type TranscriptArchiveDescriptor,
  type TranscriptArchiveManifest,
} from '../../packages/core/src/transcript/archive-renderer.js';

const mode = process.argv[2];
const video = process.argv[3] === '--video' ? process.argv[4] : undefined;
if (
  ![
    '--provision-folder',
    '--archive-once',
    '--verify-video',
    '--recover-readback',
  ].includes(mode!) ||
  (mode === '--provision-folder'
    ? process.argv.length !== 3
    : process.argv.length !== 5 || video !== 'rUhllpnYWR8')
)
  throw new Error('EXPLICIT_TRANSCRIPT_ARCHIVE_ACTION_REQUIRED');
if (
  mode === '--recover-readback' &&
  !existsSync(
    '.local/d1-resume/' +
      new Date().toISOString().slice(0, 10) +
      '-transcript-verify-video-intent.json',
  )
)
  throw new Error('PRIOR_TRANSCRIPT_VERIFICATION_REQUIRED');
if (defaults.paid_services_enabled !== false)
  throw new Error('PAID_POLICY_DENIED');
const now = new Date(),
  day = now.toISOString().slice(0, 10);
const probe = JSON.parse(
  readFileSync('docs/verification/release/d1-probe-' + day + '.json', 'utf8'),
);
if (
  probe.state !== 'AVAILABLE' ||
  Date.parse(probe.observed_at) > now.getTime() ||
  new Date(probe.observed_at).toISOString().slice(0, 10) !== day
)
  throw new Error('ACTUAL_CURRENT_DAY_D1_PROBE_REQUIRED');
const sample = JSON.parse(
  readFileSync('.local/d1-usage/latest.json', 'utf8'),
) as UsageSample;
if (!d1UsagePolicy(sample, now).noncritical_admitted)
  throw new Error('D1_TRANSCRIPT_BUDGET_NOT_ADMITTED');
if (
  !process.env.DRIVE_EXPORT_WORKER_CREDENTIAL ||
  !process.env.GOOGLE_DRIVE_CLIENT_ID ||
  !process.env.GOOGLE_DRIVE_CLIENT_SECRET ||
  !process.env.DRIVE_WRAPPING_KEY_ID ||
  !process.env.DRIVE_WRAPPING_KEY ||
  process.env.DRIVE_KEY_RECOVERY_READY !== 'true'
)
  throw new Error('PRIVATE_DRIVE_CONFIGURATION_REQUIRED');
const intent =
  '.local/d1-resume/' + day + '-transcript-' + mode!.slice(2) + '-intent.json';
if (existsSync(intent)) throw new Error('TRANSCRIPT_LIVE_ALREADY_ATTEMPTED');
mkdirSync('.local/d1-resume', { recursive: true });
writeFileSync(
  intent,
  JSON.stringify({
    started_at: now.toISOString(),
    action: mode,
    gemini_requests: 0,
    paid_services_enabled: false,
  }) + '\n',
  { flag: 'wx' },
);
const budget = d1TestBudget(queryBatch, {
    requests: 100,
    rows_read: 15000,
    rows_written: 1000,
  }),
  db = remoteDatabase(budget.execute);
let result: unknown;
try {
  const migrations = (
    await db
      .prepare(
        `SELECT name,sha256 FROM applied_migrations ORDER BY name LIMIT ${ledger.migrations.length + 1}`,
      )
      .all()
  ).results;
  if (
    JSON.stringify(migrations) !==
    JSON.stringify(
      ledger.migrations.map(({ name, sha256 }) => ({ name, sha256 })),
    )
  )
    throw new Error('EXACT_CURRENT_SCHEMA_REQUIRED');
  const context = await AccessContext.worker(
    db,
    await sha256(process.env.DRIVE_EXPORT_WORKER_CREDENTIAL!),
  );
  context.requireTask('DRIVE_EXPORT');
  const row = await db
    .prepare(
      "SELECT connection_id FROM drive_connections WHERE owner_id=? AND root_id=? AND auth_state='CONNECTED' LIMIT 2",
    )
    .bind(context.ownerId, '1rn_5auxY_8HAeADc1RgGKQ6h9JimD7WM')
    .all<{ connection_id: string }>();
  if (row.results.length !== 1)
    throw new Error('APPROVED_DAILY_CONNECTION_REQUIRED');
  const client = async (connectionId: string) => {
    const grant = await refreshDriveAccess(
      db,
      context,
      {
        client_id: process.env.GOOGLE_DRIVE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET!,
        app_origin: process.env.APP_ORIGIN!,
      },
      await importDriveWrappingKey(
        process.env.DRIVE_WRAPPING_KEY_ID!,
        process.env.DRIVE_WRAPPING_KEY!,
      ),
      connectionId,
      new Date(),
    );
    return new DriveClient(grant.access_token);
  };
  result =
    mode === '--provision-folder'
      ? await provisionTranscriptFolder(
          db,
          context,
          await client(row.results[0]!.connection_id),
          {
            connection_id: row.results[0]!.connection_id,
            parent_id: '1aFYzO7kMVebvP-Y-V6oIWAAkf21MR7mN',
          },
          new Date(),
        )
      : null;
  if (video) {
    const itemId = await db
      .prepare(
        "SELECT item_id FROM items WHERE owner_id=? AND namespace='youtube' AND external_id=?",
      )
      .bind(context.ownerId, video)
      .first<string>('item_id');
    if (!itemId) throw new Error('APPROVED_TRANSCRIPT_ITEM_REQUIRED');
    const archive = new TranscriptDriveArchive(db, context);
    if (mode === '--recover-readback')
      await archive.refreshVerifiedReadback(
        itemId,
        await client(row.results[0]!.connection_id),
        new Date(),
      );
    const attempt =
      mode === '--archive-once'
        ? await archive.tick({ client, item_id: itemId }, new Date())
        : { state: 'READ_ONLY_VERIFICATION' };
    const archived = await db
      .prepare(
        'SELECT state,source_artifact_id,segment_map_artifact_id,source_hash,descriptor_json,folder_id,reserved_file_id,verified_hash,remote_version,fencing_token,attempt_count FROM transcript_archives WHERE owner_id=? AND item_id=?',
      )
      .bind(context.ownerId, itemId)
      .first<{
        state: string;
        source_artifact_id: string;
        segment_map_artifact_id: string;
        source_hash: string;
        descriptor_json: string;
        folder_id: string;
        reserved_file_id: string;
        verified_hash: string;
        remote_version: string;
        fencing_token: number;
        attempt_count: number;
      }>();
    if (!archived || archived.state !== 'VERIFIED')
      throw new Error('APPROVED_TRANSCRIPT_NOT_VERIFIED');
    const artifacts = new ArtifactRepository(db, context),
      at = new Date();
    const source = await artifacts.readTranscriptArchiveText(
      archived.source_artifact_id,
      at,
    );
    const map = await artifacts.readTranscriptArchiveText(
      archived.segment_map_artifact_id,
      at,
    );
    const descriptor = JSON.parse(
      archived.descriptor_json,
    ) as TranscriptArchiveDescriptor;
    const manifest = JSON.parse(map.text) as TranscriptArchiveManifest;
    if (descriptor.video_id !== video || manifest.coverage.length !== 1071)
      throw new Error('APPROVED_TRANSCRIPT_COVERAGE_MISMATCH');
    const expected = await renderTranscriptArchive({
      descriptor,
      source_text: source.text,
      source_hash: archived.source_hash,
      manifest,
    });
    const drive = await client(row.results[0]!.connection_id);
    await drive.verifyPrivateFolder(archived.folder_id);
    const before = await drive.getFile(archived.reserved_file_id);
    const downloaded = await drive.readTranscriptMarkdown(
      archived.reserved_file_id,
    );
    const after = await drive.getFile(archived.reserved_file_id);
    if (
      before.version !== after.version ||
      after.version !== archived.remote_version ||
      after.trashed !== false ||
      !after.parents?.includes(archived.folder_id) ||
      downloaded !== expected.markdown ||
      (await sha256(downloaded)) !== archived.verified_hash ||
      expected.content_hash !== archived.verified_hash
    )
      throw new Error('TRANSCRIPT_INDEPENDENT_READBACK_MISMATCH');
    const dedup =
      mode === '--archive-once'
        ? await archive.tick({ client, item_id: itemId }, new Date())
        : await new TranscriptDriveArchive(
            remoteDatabase(async (queries) => {
              // Verification must prove IDLE without creating an archive or
              // changing a job if a newer source appeared concurrently.
              if (queries.some((query) => !/^SELECT\b/i.test(query.sql.trim())))
                throw new Error('TRANSCRIPT_READ_ONLY_DEDUP_MUTATION_REFUSED');
              return budget.execute(queries);
            }),
            context,
          ).tick(
            {
              item_id: itemId,
              client: async () => {
                throw new Error('TRANSCRIPT_READ_ONLY_DEDUP_DRIVE_REFUSED');
              },
            },
            new Date(),
          );
    if (dedup && dedup.state !== 'IDLE')
      throw new Error('TRANSCRIPT_DEDUP_NOT_IDLE');
    result = {
      state: 'VERIFIED',
      video_id: video,
      file_id: archived.reserved_file_id,
      folder_id: archived.folder_id,
      remote_version: archived.remote_version,
      sha256: archived.verified_hash,
      byte_count: expected.byte_count,
      cues: manifest.coverage.length,
      source_hash: archived.source_hash,
      byte_for_byte_readback: true,
      private_folder_verified: true,
      attempt,
      dedup,
      attempt_count: archived.attempt_count,
      fencing_token: archived.fencing_token,
    };
  }
} catch (error) {
  result = {
    state: 'RECOVERY_REQUIRED',
    reason:
      error instanceof Error && /^[A-Z][A-Z_0-9]{1,100}$/.test(error.message)
        ? error.message
        : 'TRANSCRIPT_LIVE_FAILED_NO_AUTOMATIC_RETRY',
  };
  process.exitCode = 2;
}
const output =
  'docs/verification/drive/transcript-' +
  mode!.slice(2) +
  '-' +
  day +
  '-' +
  randomUUID() +
  '.json';
mkdirSync('docs/verification/drive', { recursive: true });
const receipt = {
  version: 'transcript-archive-live:1',
  observed_at: new Date().toISOString(),
  result,
  budget: budget.usage,
  gemini_requests: 0,
  destructive_cleanup: 0,
  paid_services_enabled: false,
};
writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ evidence: output, ...receipt }));
