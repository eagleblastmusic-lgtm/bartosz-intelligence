import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { publicationDate } from '../projections/dates.js';

interface Change {
  seq: number;
  component: string;
  target_id: string;
  event_type: string;
  created_at: string;
}
/** Replay bounded durable change_log pages. No GUI filter enters the queue. */
export class ExportDirtyDays {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    context.requireOwner();
  }
  async sync(now: Date) {
    if (!Number.isFinite(now.getTime()))
      throw new Error('INVALID_EXPORT_CLOCK');
    await this.db
      .prepare(
        'INSERT INTO export_dirty_cursor(owner_id) VALUES(?) ON CONFLICT(owner_id) DO NOTHING',
      )
      .bind(this.context.ownerId)
      .run();
    const cursor = await this.db
      .prepare('SELECT processed_seq FROM export_dirty_cursor WHERE owner_id=?')
      .bind(this.context.ownerId)
      .first<number>('processed_seq');
    const changes = (
      await this.db
        .prepare(
          'SELECT seq,component,target_id,event_type,created_at FROM change_log WHERE owner_id=? AND seq>? ORDER BY seq LIMIT 100',
        )
        .bind(this.context.ownerId, cursor ?? 0)
        .all<Change>()
    ).results;
    for (const change of changes) {
      const days = new Set<string>();
      let item = change.target_id;
      if (
        change.component === 'items' &&
        change.event_type === 'ITEM_METADATA_CHANGED'
      ) {
        let target: unknown;
        try {
          target = JSON.parse(change.target_id);
        } catch {
          throw new Error('EXPORT_CHANGE_LOG_FORMAT');
        }
        if (
          !target ||
          typeof target !== 'object' ||
          !('item_id' in target) ||
          typeof target.item_id !== 'string'
        )
          throw new Error('EXPORT_CHANGE_LOG_FORMAT');
        item = target.item_id;
        for (const field of ['old_published_at', 'new_published_at'] as const) {
          const value = (target as Record<string, unknown>)[field];
          if (typeof value === 'string') days.add(publicationDate(value));
        }
      }
      const itemScoped = ['items', 'jobs', 'selection', 'optional_ai'].includes(
        change.component,
      );
      if (itemScoped) {
        const row = await this.db
          .prepare(
            'SELECT published_at FROM items WHERE owner_id=? AND item_id=?',
          )
          .bind(this.context.ownerId, item)
          .first<{ published_at: string | null }>();
        if (row?.published_at) days.add(publicationDate(row.published_at));
      }
      // Coverage and shared domain corrections can affect any existing report.
      // Organization/registry drafts do not change the unfiltered accepted cut.
      const global = [
        'sources',
        'discovery',
        'entities',
        'corrections',
      ].includes(change.component);
      const statements = [];
      for (const date of days) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO export_state(owner_id,publication_date,timezone,destination_key,root_namespace,connection_id,dirty_seq,first_dirty_at,last_material_event_at) SELECT owner_id,?,'Europe/Warsaw','drive:'||root_id,root_id,connection_id,?,?,? FROM drive_connections WHERE owner_id=? AND auth_state='CONNECTED' AND root_state='VERIFIED' AND root_id IS NOT NULL ON CONFLICT(owner_id,publication_date,timezone,destination_key) DO NOTHING`,
            )
            .bind(
              date,
              change.seq,
              now.toISOString(),
              now.toISOString(),
              this.context.ownerId,
            ),
        );
      }
      if (global || days.size) {
        const dates = [...days];
        statements.push(
          this.db
            .prepare(
              `UPDATE export_state SET dirty_seq=MAX(dirty_seq,?),first_dirty_at=CASE WHEN first_dirty_at IS NULL OR (dirty_seq<=exported_seq AND desired_generation<=exported_generation) THEN ? ELSE first_dirty_at END,last_material_event_at=? WHERE owner_id=? AND destination_key GLOB 'drive:*' ${global ? '' : 'AND publication_date IN (' + dates.map(() => '?').join(',') + ')'}`,
            )
            .bind(
              change.seq,
              now.toISOString(),
              now.toISOString(),
              this.context.ownerId,
              ...(global ? [] : dates),
            ),
        );
      }
      statements.push(
        this.db
          .prepare(
            'UPDATE export_dirty_cursor SET processed_seq=MAX(processed_seq,?) WHERE owner_id=?',
          )
          .bind(change.seq, this.context.ownerId),
      );
      await this.db.batch(statements);
    }
    return {
      processed_events: changes.length,
      processed_seq: changes.at(-1)?.seq ?? cursor ?? 0,
      more_possible: changes.length === 100,
    };
  }
  async due(now: Date) {
    if (!Number.isFinite(now.getTime()))
      throw new Error('INVALID_EXPORT_CLOCK');
    const debounce = new Date(now.getTime() - 600000).toISOString(),
      maximum = new Date(now.getTime() - 1800000).toISOString();
    return (
      await this.db
        .prepare(
          `SELECT root_namespace root_id,publication_date date,dirty_seq,exported_seq,first_dirty_at,last_material_event_at FROM export_state e WHERE owner_id=? AND destination_key GLOB 'drive:*' AND (dirty_seq>exported_seq OR revision=0 OR desired_generation>exported_generation) AND (lease_owner IS NULL OR lease_until<=?) AND (last_material_event_at<=? OR first_dirty_at<=?) AND EXISTS(SELECT 1 FROM drive_connections c WHERE c.owner_id=e.owner_id AND c.connection_id=e.connection_id AND c.auth_state='CONNECTED' AND c.root_state='VERIFIED' AND c.root_id=e.root_namespace) ORDER BY first_dirty_at,publication_date,root_namespace LIMIT 20`,
        )
        .bind(this.context.ownerId, now.toISOString(), debounce, maximum)
        .all<{
          root_id: string;
          date: string;
          dirty_seq: number;
          exported_seq: number;
          first_dirty_at: string;
          last_material_event_at: string;
        }>()
    ).results;
  }
}
