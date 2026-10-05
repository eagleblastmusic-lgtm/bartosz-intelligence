import { assertContext } from './boundary.js';
import type { AccessContext, Database } from './boundary.js';
import type { SourceIdentity } from '../../../contracts/src/discovery.js';
export class SourceRepository {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async upsert(
    identity: SourceIdentity,
    now: string,
    profileRevision = 'economy-1',
  ) {
    this.context.requireOwner();
    const sourceId = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO sources(source_id,owner_id,namespace,external_id,canonical_locator,profile_revision,activated_at,due_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,namespace,external_id) DO NOTHING`,
        )
        .bind(
          sourceId,
          this.context.ownerId,
          identity.namespace,
          identity.external_id,
          identity.canonical_locator,
          profileRevision,
          now,
          now,
        ),
      this.db
        .prepare(
          `INSERT INTO channels(source_id,owner_id,youtube_channel_id,uploads_playlist_id,handle_snapshot,title)
        SELECT source_id,owner_id,external_id,?,?,? FROM sources WHERE owner_id=? AND namespace=? AND external_id=?
        ON CONFLICT(source_id) DO UPDATE SET uploads_playlist_id=excluded.uploads_playlist_id,handle_snapshot=excluded.handle_snapshot,title=excluded.title`,
        )
        .bind(
          identity.uploads_playlist_id,
          identity.handle,
          identity.title,
          this.context.ownerId,
          identity.namespace,
          identity.external_id,
        ),
    ]);
    return this.db
      .prepare(
        'SELECT * FROM sources WHERE owner_id=? AND namespace=? AND external_id=?',
      )
      .bind(this.context.ownerId, identity.namespace, identity.external_id)
      .first<{ source_id: string }>();
  }
  async get(sourceId: string) {
    return this.db
      .prepare(
        'SELECT s.*,c.title,c.uploads_playlist_id,c.youtube_channel_id,c.handle_snapshot FROM sources s LEFT JOIN channels c USING(source_id,owner_id) WHERE s.owner_id=? AND s.source_id=?',
      )
      .bind(this.context.ownerId, sourceId)
      .first();
  }
  async disable(sourceId: string, now: string, correlationId: string) {
    this.context.requireOwner();
    const result = await this.db.batch([
      this.db
        .prepare(
          'UPDATE sources SET enabled=0 WHERE owner_id=? AND source_id=?',
        )
        .bind(this.context.ownerId, sourceId),
      this.db
        .prepare(
          `INSERT INTO audit_events SELECT ?,owner_id,?,'SOURCE_DISABLED',source_id,?,? FROM sources WHERE owner_id=? AND source_id=?`,
        )
        .bind(
          crypto.randomUUID(),
          this.context.actorId,
          correlationId,
          now,
          this.context.ownerId,
          sourceId,
        ),
    ]);
    if (result[0]?.meta.changes !== 1) throw new Error('NOT_FOUND');
  }
}
