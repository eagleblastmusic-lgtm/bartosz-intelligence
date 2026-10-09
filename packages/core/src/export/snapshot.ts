import { ArtifactRepository } from '../artifacts/store.js';
import { DriveClient } from '../drive/client.js';
import { verifyDailyRead } from './consumer.js';
import { sha256 } from '../auth/crypto.js';
import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { DailyProjection } from '../projections/daily.js';
import {
  renderDaily,
  type DailyRenderInput,
  type ExportSelection,
} from './renderer.js';

/** Recover only verified existing report blocks, never reconstruct purged AI
 * data. The executor rechecks the same remote hash/version before any update. */
export async function readArchivedReportBlocks(
  client: DriveClient,
  state: { root_id: string; date: string; file_id: string; file_hash: string },
) {
  const before = await client.getFile(state.file_id);
  const markdown = await client.readMarkdown(state.file_id, 8 * 1024 * 1024);
  const after = await client.getFile(state.file_id);
  if (
    before.id !== state.file_id ||
    before.trashed !== false ||
    before.mimeType !== 'text/markdown' ||
    !before.parents?.includes(state.root_id) ||
    !before.version ||
    before.version !== after.version ||
    after.trashed !== false ||
    !after.parents?.includes(state.root_id) ||
    (await sha256(markdown)) !== state.file_hash ||
    !markdown.includes('\nexport_mode: FULL\n')
  )
    throw new Error('EXPORT_CONFLICT');
  const bytes = new TextEncoder().encode(markdown);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 256 * 1024)
    chunks.push({
      root_id: state.root_id,
      file_id: state.file_id,
      version: before.version,
      offset,
      bytes: bytes.slice(offset, offset + 256 * 1024),
    });
  await verifyDailyRead({
    root_id: state.root_id,
    file_id: state.file_id,
    date: state.date,
    version_before: before.version,
    version_after: after.version!,
    chunks,
  });
  return reportBlocks(markdown);
}

export function reportBlocks(markdown: string) {
  const body = markdown.slice(
    markdown.indexOf('\n---\n\n') + 6,
    markdown.lastIndexOf('END_REPORT date='),
  );
  const matches = [...body.matchAll(/^ITEM ([A-Za-z0-9_-]{1,128})\n/gm)];
  return Object.fromEntries(
    matches.map((match, index) => [
      match[1]!,
      body.slice(match.index, matches[index + 1]?.index ?? body.length),
    ]),
  );
}

/** Assemble the unfiltered whole day through the existing owner-scoped,
 * snapshot-bound keyset projection. Changes anywhere during canonical reads
 * invalidate the attempt; callers may retry, never publish a mixed cut. */
export async function captureDailyExport(
  db: Database,
  context: AccessContext,
  input: {
    date: string;
    app_origin: string;
    revision: number;
    mode?: DailyRenderInput['mode'];
    compact_token_budget?: number;
    archived_blocks?: Record<string, string>;
  },
  cursorSecret: string,
  now: Date,
): Promise<DailyRenderInput> {
  assertContext(context);
  context.requireOwnerOrTask('DRIVE_EXPORT');
  const projection = new DailyProjection(db, context);
  const artifacts = new ArtifactRepository(db, context);
  const snapshot = await projection.day(
    {
      date: input.date,
      timezone: 'Europe/Warsaw',
      include_undated: true,
      limit: 50,
    },
    cursorSecret,
    now,
  );
  let cursor = snapshot.next_cursor;
  while (cursor) {
    const next = await projection.day(
      {
        date: input.date,
        timezone: 'Europe/Warsaw',
        include_undated: true,
        limit: 50,
        cursor,
      },
      cursorSecret,
      now,
    );
    if (
      next.cut_seq !== snapshot.cut_seq ||
      next.projection_revision !== snapshot.projection_revision
    )
      throw new Error('READ_SNAPSHOT_CHANGED');
    snapshot.items.push(...next.items);
    cursor = next.next_cursor;
  }
  snapshot.next_cursor = null;
  if (
    snapshot.items.length !== snapshot.counts.items ||
    new Set(snapshot.items.map((item) => item.item_id)).size !==
      snapshot.counts.items
  )
    throw new Error('WHOLE_DAY_EXPORT_REQUIRED');
  const selections: ExportSelection[] = [];
  for (const item of snapshot.items) {
    if (item.archive) {
      if (!input.archived_blocks?.[item.item_id])
        throw new Error('ARCHIVED_REPORT_REQUIRES_RECOVERY');
      continue;
    }
    if (item.selected_run_id === null) continue;
    const descriptor = await projection.canonicalDescriptor(
      item.item_id,
      item.selected_run_id,
    );
    const verified = await artifacts.readVerifiedText(
      descriptor.artifact_id,
      8 * 1024 * 1024,
    );
    if (verified.artifact.content_hash !== descriptor.content_hash)
      throw new Error('EXPORT_CANONICAL_MISMATCH');
    selections.push({
      item_id: item.item_id,
      run_id: item.selected_run_id,
      canonical_hash: descriptor.content_hash,
      canonical: JSON.parse(verified.text) as ExportSelection['canonical'],
    });
  }
  const finalCut = await db
    .prepare(
      'SELECT COALESCE(MAX(seq),0) cut_seq FROM change_log WHERE owner_id=?',
    )
    .bind(context.ownerId)
    .first<{ cut_seq: number }>();
  if (Number(finalCut?.cut_seq) !== snapshot.cut_seq)
    throw new Error('READ_SNAPSHOT_CHANGED');
  return { ...input, snapshot, selections };
}

export async function renderOwnerDaily(
  db: Database,
  context: AccessContext,
  input: Parameters<typeof captureDailyExport>[2],
  cursorSecret: string,
  now: Date,
) {
  return renderDaily(
    await captureDailyExport(db, context, input, cursorSecret, now),
  );
}
