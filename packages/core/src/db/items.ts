import { assertContext } from './boundary.js';
import type { AccessContext, Database, Statement } from './boundary.js';
import type { ItemMetadata } from '../../../contracts/src/discovery.js';
import { sha256 } from '../auth/crypto.js';
import { decodeCursor, encodeCursor, pageLimit } from './cursor.js';

export class ItemRepository {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async prepareUpsert(
    sourceId: string,
    metadata: ItemMetadata,
    now: string,
    permit?: {
      predicate: string;
      bindings: readonly (string | number | null)[];
    },
  ): Promise<Statement[]> {
    const guard = permit?.predicate ?? '1';
    const bindings = permit?.bindings ?? [];
    if (
      metadata.published_at !== null &&
      (!Number.isFinite(Date.parse(metadata.published_at)) ||
        new Date(metadata.published_at).toISOString() !== metadata.published_at)
    )
      throw new Error('INVALID_PUBLICATION');
    const payload = JSON.stringify({
      namespace: metadata.namespace,
      external_id: metadata.external_id,
      item_type: metadata.item_type,
      canonical_url: metadata.canonical_url,
      title: metadata.title,
      published_at: metadata.published_at,
      publication_provenance: metadata.publication_provenance,
      availability: metadata.availability,
      duration_seconds: metadata.duration_seconds,
    });
    const hash = await sha256(payload),
      itemId = crypto.randomUUID(),
      revisionId = crypto.randomUUID();
    return [
      this.db
        .prepare(
          `INSERT INTO items(item_id,owner_id,source_id,namespace,external_id,item_type,canonical_url,published_at,publication_provenance,discovered_at,availability)
        SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(owner_id,namespace,external_id) DO NOTHING`,
        )
        .bind(
          itemId,
          this.context.ownerId,
          sourceId,
          metadata.namespace,
          metadata.external_id,
          metadata.item_type,
          metadata.canonical_url,
          metadata.published_at,
          metadata.publication_provenance,
          now,
          metadata.availability,
          ...bindings,
        ),
      this.db
        .prepare(
          `INSERT INTO item_revisions(revision_id,owner_id,item_id,metadata_hash,metadata_json,fetched_at,availability)
        SELECT ?,owner_id,item_id,?,?,?,? FROM items WHERE owner_id=? AND source_id=? AND namespace=? AND external_id=? AND ${guard}
        ON CONFLICT(owner_id,item_id,metadata_hash) DO NOTHING`,
        )
        .bind(
          revisionId,
          hash,
          payload,
          now,
          metadata.availability,
          this.context.ownerId,
          sourceId,
          metadata.namespace,
          metadata.external_id,
          ...bindings,
        ),
      this.db
        .prepare(
          `UPDATE items SET current_revision_id=(SELECT revision_id FROM item_revisions r WHERE r.owner_id=items.owner_id AND r.item_id=items.item_id AND r.metadata_hash=?),
        published_at=?,publication_provenance=?,availability=?,item_type=?,canonical_url=? WHERE owner_id=? AND source_id=? AND namespace=? AND external_id=?
        AND NOT EXISTS(SELECT 1 FROM item_revisions r WHERE r.owner_id=items.owner_id AND r.item_id=items.item_id AND r.revision_id=items.current_revision_id AND r.fetched_at>?) AND ${guard}`,
        )
        .bind(
          hash,
          metadata.published_at,
          metadata.publication_provenance,
          metadata.availability,
          metadata.item_type,
          metadata.canonical_url,
          this.context.ownerId,
          sourceId,
          metadata.namespace,
          metadata.external_id,
          now,
          ...bindings,
        ),
    ];
  }
  async upsert(sourceId: string, metadata: ItemMetadata, now: string) {
    await this.db.batch(await this.prepareUpsert(sourceId, metadata, now));
    return this.db
      .prepare(
        'SELECT item_id,current_revision_id,published_at FROM items WHERE owner_id=? AND source_id=? AND namespace=? AND external_id=?',
      )
      .bind(
        this.context.ownerId,
        sourceId,
        metadata.namespace,
        metadata.external_id,
      )
      .first<{
        item_id: string;
        current_revision_id: string;
        published_at: string | null;
      }>();
  }
  async list(limit: number, now: string, secret: string, cursor?: string) {
    this.context.requireOwner();
    pageLimit(limit);
    const position = cursor
      ? await decodeCursor(
          cursor,
          this.context.ownerId,
          'items:discovered:desc',
          secret,
        )
      : null;
    const snapshot = position?.snapshot ?? now;
    const rows = (
      await this.db
        .prepare(
          `SELECT i.item_id,i.source_id,i.discovered_at,i.published_at,i.current_revision_id,r.metadata_json
      FROM items i JOIN item_revisions r ON r.owner_id=i.owner_id AND r.item_id=i.item_id AND r.revision_id=i.current_revision_id
      WHERE i.owner_id=? AND i.discovered_at<=? AND (? IS NULL OR i.discovered_at<? OR (i.discovered_at=? AND i.item_id<?))
      ORDER BY i.discovered_at DESC,i.item_id DESC LIMIT ?`,
        )
        .bind(
          this.context.ownerId,
          snapshot,
          position?.time ?? null,
          position?.time ?? null,
          position?.time ?? null,
          position?.id ?? null,
          limit + 1,
        )
        .all<{
          item_id: string;
          discovered_at: string;
          metadata_json: string;
        }>()
    ).results;
    const page = rows.slice(0, limit),
      last = page.at(-1);
    return {
      items: page.map((row) => ({
        ...row,
        metadata: JSON.parse(row.metadata_json),
        metadata_json: undefined,
      })),
      next_cursor:
        rows.length > limit && last
          ? await encodeCursor(
              {
                owner: this.context.ownerId,
                kind: 'items:discovered:desc',
                snapshot,
                time: last.discovered_at,
                id: last.item_id,
              },
              secret,
            )
          : null,
    };
  }
}
