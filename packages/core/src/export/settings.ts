import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { requireDriveId } from '../drive/client.js';
import { requireLocalDate } from '../projections/dates.js';

export class ExportSettings {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    context.requireOwner();
  }
  async mode(
    root: string,
    date: string,
    mode: 'COMPACT' | 'FULL',
    expected: number,
    now: Date,
  ) {
    requireDriveId(root);
    requireLocalDate(date);
    if (
      !['COMPACT', 'FULL'].includes(mode) ||
      !Number.isSafeInteger(expected) ||
      expected < 1 ||
      !Number.isFinite(now.getTime())
    )
      throw new Error('INVALID_EXPORT_SETTINGS');
    const result = await this.db
      .prepare(
        `UPDATE export_state SET desired_mode=?,settings_revision=settings_revision+1,desired_generation=desired_generation+1,first_dirty_at=CASE WHEN first_dirty_at IS NULL OR (dirty_seq<=exported_seq AND desired_generation<=exported_generation) THEN ? ELSE first_dirty_at END,last_material_event_at=?,lease_owner=NULL,lease_until=NULL,fencing_token=fencing_token+1 WHERE owner_id=? AND root_namespace=? AND publication_date=? AND destination_key GLOB 'drive:*' AND settings_revision=? AND COALESCE(desired_mode,mode)!=?`,
      )
      .bind(
        mode,
        now.toISOString(),
        now.toISOString(),
        this.context.ownerId,
        root,
        date,
        expected,
        mode,
      )
      .run();
    const row = await this.db
      .prepare(
        `SELECT settings_revision,COALESCE(desired_mode,mode) desired_mode FROM export_state WHERE owner_id=? AND root_namespace=? AND publication_date=? AND destination_key GLOB 'drive:*'`,
      )
      .bind(this.context.ownerId, root, date)
      .first<{ settings_revision: number; desired_mode: string }>();
    if (!row) throw new Error('NOT_FOUND');
    if (
      row.settings_revision !== expected + (result.meta.changes ? 1 : 0) ||
      row.desired_mode !== mode
    )
      throw new Error('REVISION_CONFLICT');
    return row;
  }
}
