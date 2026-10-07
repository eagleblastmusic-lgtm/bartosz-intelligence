import { ArtifactRepository } from '../artifacts/store.js';
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
  },
  cursorSecret: string,
  now: Date,
): Promise<DailyRenderInput> {
  assertContext(context);
  context.requireOwner();
  const projection = new DailyProjection(db, context);
  const artifacts = new ArtifactRepository(db, context);
  const snapshot = await projection.day(
    { date: input.date, timezone: 'Europe/Warsaw', limit: 50 },
    cursorSecret,
    now,
  );
  let cursor = snapshot.next_cursor;
  while (cursor) {
    const next = await projection.day(
      { date: input.date, timezone: 'Europe/Warsaw', limit: 50, cursor },
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
