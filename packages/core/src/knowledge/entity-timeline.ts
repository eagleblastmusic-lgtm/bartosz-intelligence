import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { decodeCursor, encodeCursor, pageLimit } from '../db/cursor.js';
import { effectiveEntity } from './identity.js';
import { sha256 } from '../auth/crypto.js';
export class EntityTimeline {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    context.requireOwner();
  }
  async page(
    entityId: string,
    limit: number,
    secret: string,
    now: Date,
    cursorValue?: string,
  ) {
    pageLimit(limit);
    if (!entityId || entityId.length > 128) throw new Error('INVALID_ENTITY');
    const kind = 'entity-timeline:1:' + entityId;
    const cursor = cursorValue
      ? await decodeCursor(cursorValue, this.context.ownerId, kind, secret)
      : null;
    const entity = await this.db
      .prepare('SELECT 1 FROM entities WHERE owner_id=? AND entity_id=?')
      .bind(this.context.ownerId, entityId)
      .first();
    if (!entity) throw new Error('NOT_FOUND');
    const results = await this.db.batch([
      this.db
        .prepare(
          'SELECT COALESCE(MAX(seq),0) cut_seq FROM change_log WHERE owner_id=?',
        )
        .bind(this.context.ownerId),
      this.db
        .prepare(
          `SELECT o.observation_id,o.kind,o.row_json,o.row_hash,o.recorded_at,o.run_id,i.item_id,i.source_id,i.published_at,json_extract(m.metadata_json,'$.title') title
      FROM observations o JOIN analysis_runs r ON r.owner_id=o.owner_id AND r.run_id=o.run_id AND r.state='ACCEPTED' AND json_extract(r.outcome_json,'$.version')='intelligence-accepted:1'
      JOIN items i ON i.owner_id=r.owner_id AND i.item_id=r.item_id JOIN item_revisions m ON m.owner_id=i.owner_id AND m.item_id=i.item_id AND m.revision_id=i.current_revision_id
      WHERE o.owner_id=? AND EXISTS(SELECT 1 FROM observation_entities e WHERE e.owner_id=o.owner_id AND e.observation_id=o.observation_id AND ${effectiveEntity('e')}=(SELECT ${effectiveEntity('t')} FROM entities t WHERE t.owner_id=o.owner_id AND t.entity_id=?))
      AND (? IS NULL OR COALESCE(i.published_at,'')<? OR (COALESCE(i.published_at,'')=? AND o.observation_id>?))
      ORDER BY COALESCE(i.published_at,'') DESC,o.observation_id LIMIT ?`,
        )
        .bind(
          this.context.ownerId,
          entityId,
          cursor?.id ?? null,
          cursor?.time ?? '',
          cursor?.time ?? '',
          cursor?.id ?? '',
          limit + 1,
        ),
    ]);
    const cut = String(
      (results[0]!.results![0] as { cut_seq: number }).cut_seq,
    );
    if (cursor && cursor.snapshot !== cut)
      throw new Error('READ_SNAPSHOT_CHANGED');
    const rows = results[1]!.results! as {
      observation_id: string;
      kind: string;
      row_json: string;
      row_hash: string;
      recorded_at: string;
      run_id: string;
      item_id: string;
      source_id: string;
      published_at: string | null;
      title: string | null;
    }[];
    const observations = await Promise.all(
      rows.slice(0, limit).map(async ({ row_json, row_hash, ...row }) => {
        if ((await sha256(row_json)) !== row_hash)
          throw new Error('LEDGER_INTEGRITY_FAILED');
        const observation = JSON.parse(row_json) as Record<string, unknown>;
        if (
          observation.observation_id !== row.observation_id ||
          observation.kind !== row.kind
        )
          throw new Error('LEDGER_INTEGRITY_FAILED');
        return { ...row, observation };
      }),
    );
    const last = observations.at(-1);
    return {
      observations,
      cut_seq: cut,
      chronology: 'SOURCE_PUBLICATION_NULL_LAST' as const,
      next_cursor:
        rows.length > limit && last
          ? await encodeCursor(
              {
                owner: this.context.ownerId,
                kind,
                snapshot: cut,
                time: last.published_at ?? '',
                id: last.observation_id,
              },
              secret,
            )
          : null,
    };
  }
  async events(
    entityId: string,
    limit: number,
    secret: string,
    cursorValue?: string,
  ) {
    pageLimit(limit);
    if (!entityId || entityId.length > 128) throw new Error('INVALID_ENTITY');
    const kind = 'entity-events:1:' + entityId;
    const cursor = cursorValue
      ? await decodeCursor(cursorValue, this.context.ownerId, kind, secret)
      : null;
    if (
      !(await this.db
        .prepare('SELECT 1 FROM entities WHERE owner_id=? AND entity_id=?')
        .bind(this.context.ownerId, entityId)
        .first())
    )
      throw new Error('NOT_FOUND');
    const results = await this.db.batch([
      this.db
        .prepare(
          'SELECT COALESCE(MAX(seq),0) cut_seq FROM change_log WHERE owner_id=?',
        )
        .bind(this.context.ownerId),
      this.db
        .prepare(
          `WITH members AS (SELECT e.entity_id FROM entities e WHERE e.owner_id=? AND ${effectiveEntity('e')}=(SELECT ${effectiveEntity('t')} FROM entities t WHERE t.owner_id=e.owner_id AND t.entity_id=?)), events AS (
        SELECT 'ALIAS:'||decision_id event_id,'ALIAS_'||action action,reason,authored_by,recorded_at,normalized_literal text FROM entity_alias_decisions WHERE owner_id=? AND entity_id IN (SELECT entity_id FROM members)
        UNION ALL SELECT 'IDENTITY:'||k.event_id,k.action,k.reason,k.authored_by,k.recorded_at,NULL FROM entity_identity_events k WHERE k.owner_id=? AND EXISTS(SELECT 1 FROM entity_identity_members m WHERE m.owner_id=k.owner_id AND m.event_id=k.event_id AND m.entity_id IN (SELECT entity_id FROM members))
        UNION ALL SELECT 'CORRECTION:'||correction_id,'LABEL_'||action,reason,authored_by,recorded_at,new_value FROM correction_overlays WHERE owner_id=? AND target_kind='ENTITY_LABEL' AND target_id IN (SELECT entity_id FROM members)
      ) SELECT * FROM events WHERE (? IS NULL OR recorded_at<? OR (recorded_at=? AND event_id>?)) ORDER BY recorded_at DESC,event_id LIMIT ?`,
        )
        .bind(
          this.context.ownerId,
          entityId,
          this.context.ownerId,
          this.context.ownerId,
          this.context.ownerId,
          cursor?.id ?? null,
          cursor?.time ?? '',
          cursor?.time ?? '',
          cursor?.id ?? '',
          limit + 1,
        ),
    ]);
    const cut = String(
      (results[0]!.results![0] as { cut_seq: number }).cut_seq,
    );
    if (cursor && cursor.snapshot !== cut)
      throw new Error('READ_SNAPSHOT_CHANGED');
    const rows = results[1]!.results! as {
      event_id: string;
      action: string;
      reason: string;
      authored_by: string;
      recorded_at: string;
      text: string | null;
    }[];
    const events = rows.slice(0, limit),
      last = events.at(-1);
    return {
      events,
      cut_seq: cut,
      chronology: 'OWNER_ACTION_TIME' as const,
      next_cursor:
        rows.length > limit && last
          ? await encodeCursor(
              {
                owner: this.context.ownerId,
                kind,
                snapshot: cut,
                time: last.recorded_at,
                id: last.event_id,
              },
              secret,
            )
          : null,
    };
  }
}
