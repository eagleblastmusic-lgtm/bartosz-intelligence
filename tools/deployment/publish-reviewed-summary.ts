import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { remoteDatabase, queryBatch } from './cloudflare.mjs';
import { d1TestBudget } from './d1-test-budget.js';
import { d1UsagePolicy } from './d1-usage-policy.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { sha256, randomToken } from '../../packages/core/src/auth/crypto.js';
import { DriveClient } from '../../packages/core/src/drive/client.js';
import { refreshDriveAccess } from '../../packages/core/src/drive/oauth.js';
import { importDriveWrappingKey } from '../../packages/core/src/drive/credentials.js';
import { publishReviewedMarkdown } from '../../packages/core/src/export/reviewed-publication.js';
import { validateCanonical } from '../../packages/core/src/ai/repair/validate.js';
import { canonicalCitations } from '../../packages/core/src/export/analysis-view.js';
import { requirePrivateRecoveryDirectory } from '../db/private-directory.js';

// Explicit owner-reviewed exception. Does not run AI, mutate the source run,
// replace a normal day report, mark general model quality PASS or enable cleanup.
const [
  ,
  ,
  flag,
  receiptFile,
  dailyRoot,
  applicationRoot,
  usageFlag,
  usageFile,
] = process.argv;
if (
  process.argv.length !== 8 ||
  flag !== '--live' ||
  !receiptFile ||
  !dailyRoot ||
  !applicationRoot ||
  usageFlag !== '--usage' ||
  !usageFile
)
  throw new Error('EXPLICIT_OWNER_REVIEW_PUBLICATION_REQUIRED');
const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
const decision = receipt.owner_decision;
if (
  receipt.status !== 'OWNER_ACCEPTED_FOR_PUBLICATION' ||
  decision?.version !== 'owner-result-publication-decision:1' ||
  decision.scope !== 'ONE_EDITORIALLY_REVISED_RESULT' ||
  decision.conditions_fulfilled !== true ||
  decision.model_qualification !== false ||
  decision.cp3_13_accepted !== false ||
  decision.new_ai_requests_authorized !== 0 ||
  decision.original_run_id !== receipt.original_run_id ||
  !/^[A-Za-z0-9_-]{11}$/.test(decision.video_id) ||
  !Number.isSafeInteger(receipt.version) ||
  receipt.version < 1
)
  throw new Error('EXPLICIT_SCOPED_OWNER_DECISION_REQUIRED');
const output =
  'docs/verification/gate-ai/owner-reviewed-publication-' +
  decision.video_id +
  '-v' +
  receipt.version +
  '.json';
if (existsSync(output)) {
  const done = JSON.parse(readFileSync(output, 'utf8'));
  if (
    done.status !== 'VERIFIED' ||
    done.revision_hash !== receipt.revision_hash ||
    done.root_id !== dailyRoot
  )
    throw new Error('PUBLICATION_EVIDENCE_CONFLICT');
  console.log(
    JSON.stringify({
      status: 'ALREADY_VERIFIED',
      file_id: done.file_id,
      production_requests: 0,
      gemini_requests: 0,
    }),
  );
  process.exit(0);
}
const usage = JSON.parse(readFileSync(usageFile, 'utf8'));
if (!d1UsagePolicy(usage, new Date()).noncritical_admitted)
  throw new Error('FRESH_D1_OBSERVED_BUDGET_REQUIRED');
const journalRoot = resolve(
  '.local/owner-reviewed-publication/' +
    decision.video_id +
    '-v' +
    receipt.version,
);
requirePrivateRecoveryDirectory(journalRoot);
const reviewPath = resolve(receipt.review_file),
  base = dirname(reviewPath);
const root = resolve('.local/ai-pilot') + '\\';
if (!reviewPath.startsWith(root))
  throw new Error('PRIVATE_REVIEW_PATH_REQUIRED');
const privateText = (file: string) => {
  if (file !== file.split(/[\\/]/).at(-1))
    throw new Error('INVALID_REVIEW_FILE');
  return readFileSync(join(base, file), 'utf8');
};
for (const file of receipt.files)
  if ((await sha256(privateText(file.file))) !== file.sha256)
    throw new Error('REVIEW_FILE_PIN_MISMATCH');
const canonical = JSON.parse(
  privateText(`editorial-canonical-v${receipt.version}.json`),
);
if (
  !validateCanonical(canonical) ||
  (await sha256(JSON.stringify(canonical))) !==
    receipt.canonical_revision_sha256
)
  throw new Error('REVIEW_CANONICAL_INVALID');
canonicalCitations(
  canonical,
  canonical.evidence.map((e: { evidence_id: string }) => e.evidence_id),
  'https://www.youtube.com/watch?v=' + decision.video_id,
);
const budget = d1TestBudget(queryBatch, {
  requests: 30,
  rows_read: 3000,
  rows_written: 200,
});
const db = remoteDatabase(budget.execute);
const subject = process.env.GOOGLE_OIDC_OWNER_SUBJECT;
if (!subject || process.env.DRIVE_KEY_RECOVERY_READY !== 'true')
  throw new Error('OWNER_DRIVE_CONFIGURATION_REQUIRED');
const ownerId = await db
  .prepare('SELECT owner_id FROM owner_users WHERE subject=? AND allowlisted=1')
  .bind(subject)
  .first<string>('owner_id');
if (!ownerId) throw new Error('VERIFIED_OWNER_REQUIRED');
const createdAt = new Date().toISOString(),
  expiresAt = new Date(Date.now() + 300000).toISOString(),
  sessionHash = await sha256(randomToken());
const cleanupBudget = d1TestBudget(queryBatch, {
  requests: 1,
  rows_read: 20,
  rows_written: 10,
});
await db
  .prepare(
    'INSERT INTO owner_sessions(session_hash,owner_id,csrf_hash,created_at,expires_at) SELECT ?,owner_id,?,?,? FROM owner_users WHERE owner_id=? AND subject=? AND allowlisted=1',
  )
  .bind(
    sessionHash,
    await sha256(randomToken()),
    createdAt,
    expiresAt,
    ownerId,
    subject,
  )
  .run();
let phase = 'PRECHECK';
const evidence: Record<string, unknown> = {
  version: 'owner-reviewed-summary-live:1',
  started_at: createdAt,
  video_id: decision.video_id,
  revision_hash: receipt.revision_hash,
  canonical_revision_sha256: receipt.canonical_revision_sha256,
  decision_reference: decision.reference,
  original_run_id: receipt.original_run_id,
  basis: 'ACTUAL_PROVIDER',
  paid_services_enabled: false,
  gemini_requests: 0,
  original_run_promoted: false,
  model_qualification: false,
  cp3_13_accepted: false,
  production_deletes: 0,
};
try {
  const context = await AccessContext.owner(db, sessionHash, createdAt);
  const original = await db
    .prepare(
      "SELECT r.item_id,r.outcome_json,r.candidate_hash,j.state,j.reason_code FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.run_id=? AND r.state='CANDIDATE' AND j.task_type='ANALYZE' AND j.state='SUCCEEDED' AND j.reason_code='QUALITY_TEST_COMPLETE'",
    )
    .bind(ownerId, receipt.original_run_id)
    .first<{
      item_id: string;
      outcome_json: string;
      candidate_hash: string;
      state: string;
      reason_code: string;
    }>();
  if (
    !original ||
    original.item_id !== canonical.item_id ||
    (await sha256(original.outcome_json)) !== original.candidate_hash
  )
    throw new Error('IMMUTABLE_QUALITY_TEST_REQUIRED');
  const validation = JSON.parse(original.outcome_json).validation;
  if (
    validation?.mode !== 'QUALITY_TEST' ||
    validation.accepted !== false ||
    validation.canonical_hash !== receipt.original_canonical_sha256
  )
    throw new Error('ORIGINAL_CANDIDATE_PIN_MISMATCH');
  const pins = (
    await db
      .prepare(
        'SELECT artifact_id,content_hash,state FROM artifacts WHERE owner_id=? AND item_id=? AND artifact_id IN (?,?,?)',
      )
      .bind(
        ownerId,
        original.item_id,
        validation.response_artifact_id,
        validation.canonical_artifact_id,
        canonical.source_artifact_id,
      )
      .all<{ artifact_id: string; content_hash: string; state: string }>()
  ).results;
  if (
    pins.length !== 3 ||
    pins.some((p) => p.state !== 'VERIFIED') ||
    pins.find((p) => p.artifact_id === validation.canonical_artifact_id)
      ?.content_hash !== receipt.original_canonical_sha256 ||
    pins.find((p) => p.artifact_id === validation.response_artifact_id)
      ?.content_hash !==
      (await sha256(
        readFileSync(join(dirname(base), 'provider-output.json'), 'utf8'),
      )) ||
    pins.find((p) => p.artifact_id === canonical.source_artifact_id)
      ?.content_hash !== canonical.evidence[0]?.source_hash
  )
    throw new Error('ORIGINAL_ARTIFACT_PINS_INVALID');
  const item = await db
    .prepare(
      "SELECT i.canonical_url,i.published_at,m.metadata_json,COALESCE(c.title,'Źródło') creator FROM items i JOIN item_revisions m ON m.owner_id=i.owner_id AND m.item_id=i.item_id AND m.revision_id=i.current_revision_id LEFT JOIN channels c ON c.owner_id=i.owner_id AND c.source_id=i.source_id WHERE i.owner_id=? AND i.item_id=?",
    )
    .bind(ownerId, original.item_id)
    .first<{
      canonical_url: string;
      published_at: string | null;
      metadata_json: string;
      creator: string;
    }>();
  if (
    !item ||
    new URL(item.canonical_url).searchParams.get('v') !== decision.video_id
  )
    throw new Error('REVIEW_VIDEO_MISMATCH');
  const title = JSON.parse(item.metadata_json).title;
  if (typeof title !== 'string') throw new Error('VIDEO_TITLE_REQUIRED');
  const markdown = [
    '# Polskie streszczenie — zaakceptowana rewizja redakcyjna',
    '',
    'Tytuł: ' + JSON.stringify(title),
    'Kanał: ' + JSON.stringify(item.creator),
    'Video ID: ' + decision.video_id,
    'Film: ' + item.canonical_url,
    'Publikacja źródła: ' + (item.published_at ?? 'nieustalona'),
    'Decyzja właściciela: ' + decision.reference,
    'Dokument zawiera redakcję istniejącego wyniku AI. Nie jest kwalifikacją modelu ani nową generacją.',
    '',
    readFileSync(reviewPath, 'utf8'),
  ].join('\n');
  const hash = await sha256(markdown),
    name =
      decision.recorded_at.slice(0, 10) +
      '-' +
      decision.video_id +
      '-owner-reviewed-v' +
      receipt.version +
      '.md';
  const key =
    'owner-reviewed-summary-' + original.item_id + '-' + receipt.revision_hash;
  const latest = async () =>
    db
      .prepare(
        'SELECT revision,payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id=? ORDER BY revision DESC LIMIT 1',
      )
      .bind(ownerId, key)
      .first<{
        revision: number;
        payload_json: string;
        content_hash: string;
      }>();
  const save = async (revision: number, record: Record<string, unknown>) => {
    context.requireOwner();
    const payload = JSON.stringify(record),
      contentHash = await sha256(payload);
    await db
      .prepare(
        'INSERT INTO config_versions(config_id,owner_id,revision,payload_json,content_hash,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
      )
      .bind(
        key,
        ownerId,
        revision,
        payload,
        contentHash,
        new Date().toISOString(),
      )
      .run();
    const result = await latest();
    if (
      !result ||
      result.revision !== revision ||
      result.content_hash !== contentHash
    )
      throw new Error('OWNER_PUBLICATION_RECEIPT_CONFLICT');
    return record;
  };
  const connection = await db
    .prepare(
      "SELECT connection_id FROM drive_connections WHERE owner_id=? AND root_id=? AND auth_state='CONNECTED' AND root_state='VERIFIED' LIMIT 1",
    )
    .bind(ownerId, dailyRoot)
    .first<string>('connection_id');
  if (!connection) throw new Error('EXISTING_VERIFIED_DAILY_REQUIRED');
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
    connection,
    new Date(),
  );
  let driveRequests = 0,
    creates = 0;
  const client = new DriveClient(grant.access_token, async (target, init) => {
    if (
      new URL(String(target)).hostname !== 'www.googleapis.com' ||
      ['DELETE', 'PATCH', 'PUT'].includes(init?.method ?? 'GET')
    )
      throw new Error('PUBLICATION_TRANSPORT_SCOPE_DENIED');
    if (init?.method === 'POST' && ++creates > 1)
      throw new Error('SECOND_CREATE_REFUSED');
    if (++driveRequests > 12)
      throw new Error('DRIVE_PUBLICATION_BUDGET_EXHAUSTED');
    return fetch(target, init);
  });
  const folder = await client.getFile(dailyRoot);
  if (
    folder.mimeType !== 'application/vnd.google-apps.folder' ||
    folder.trashed !== false ||
    !folder.parents?.includes(applicationRoot)
  )
    throw new Error('OWNER_APPROVED_FOLDER_LAYOUT_REQUIRED');
  let state = await latest();
  if (state && (await sha256(state.payload_json)) !== state.content_hash)
    throw new Error('OWNER_PUBLICATION_RECEIPT_CORRUPT');
  let record = state ? JSON.parse(state.payload_json) : null;
  if (
    record &&
    (record.root_id !== dailyRoot ||
      record.content_hash !== hash ||
      record.revision_hash !== receipt.revision_hash ||
      record.decision_reference !== decision.reference)
  )
    throw new Error('OWNER_PUBLICATION_RECEIPT_CONFLICT');
  if (!record) {
    record = await save(1, {
      version: 'owner-reviewed-summary-intent:1',
      state: 'RESERVED',
      file_id: await client.reserveId(),
      root_id: dailyRoot,
      name,
      content_hash: hash,
      revision_hash: receipt.revision_hash,
      decision_reference: decision.reference,
      original_run_id: receipt.original_run_id,
      original_canonical_hash: receipt.original_canonical_sha256,
      editorial_canonical_hash: receipt.canonical_revision_sha256,
      owner_decision: decision,
      accepted_content: true,
      original_run_promoted: false,
      create_attempted: false,
    });
    state = await latest();
  }
  writeFileSync(join(journalRoot, 'prepared.md'), markdown, { mode: 0o600 });
  phase = 'PUBLICATION';
  const result = await publishReviewedMarkdown(client, {
    file_id: record.file_id,
    root_id: dailyRoot,
    name,
    markdown,
    content_hash: hash,
    revision_hash: receipt.revision_hash,
    decision_reference: decision.reference,
    create_attempted: record.create_attempted,
    before_create: async () => {
      record = await save(2, {
        ...record,
        state: 'CREATE_INTENT',
        create_attempted: true,
      });
    },
  });
  if (state?.revision !== 3)
    await save(3, {
      ...record,
      ...result,
      create_attempted: true,
      verified_at: new Date().toISOString(),
    });
  Object.assign(evidence, {
    status: 'VERIFIED',
    ...result,
    drive_requests: driveRequests,
    create_requests: creates,
    verified_at: new Date().toISOString(),
    operational_receipt_key: key,
    original_run_state: 'CANDIDATE',
    normal_daily_report_replaced: false,
    automatic_p0_acceptance: false,
    full_e2e: 'INCOMPLETE',
    review_file_sha256: receipt.files.find(
      (f: { file: string }) => f.file === reviewPath.split(/[\\/]/).at(-1),
    )?.sha256,
  });
} catch (error) {
  Object.assign(evidence, {
    status: 'PENDING',
    phase,
    reason:
      error instanceof Error && /^[A-Z0-9_:]+$/.test(error.message)
        ? error.message
        : 'PUBLICATION_FAILED',
  });
  process.exitCode = 1;
} finally {
  const revoked = await remoteDatabase(cleanupBudget.execute)
    .prepare(
      'UPDATE owner_sessions SET revoked_at=? WHERE owner_id=? AND session_hash=? AND created_at=? AND expires_at=? AND revoked_at IS NULL',
    )
    .bind(new Date().toISOString(), ownerId, sessionHash, createdAt, expiresAt)
    .run();
  Object.assign(evidence, {
    session_revoked: revoked.meta.changes === 1,
    production_d1: budget.usage,
    session_revocation_d1: cleanupBudget.usage,
    finished_at: new Date().toISOString(),
  });
  if (revoked.meta.changes !== 1) process.exitCode = 1;
  mkdirSync(dirname(output), { recursive: true });
  if (evidence.status === 'VERIFIED')
    writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', {
      flag: 'wx',
    });
  else
    writeFileSync(
      join(journalRoot, 'pending-' + Date.now() + '.json'),
      JSON.stringify(evidence, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
  console.log(
    JSON.stringify({
      status: evidence.status,
      phase,
      reason: evidence.reason,
      file_id: evidence.file_id,
      create_requests: evidence.create_requests,
      production_d1: budget.usage,
      session_revoked: evidence.session_revoked,
      gemini_requests: 0,
    }),
  );
}
