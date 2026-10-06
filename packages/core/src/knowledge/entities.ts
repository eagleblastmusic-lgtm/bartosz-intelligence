import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
import { decodeCursor, encodeCursor, pageLimit } from '../db/cursor.js';
export const effectiveAlias = `COALESCE((SELECT d.action FROM entity_alias_decisions d WHERE d.owner_id=a.owner_id AND d.alias_id=a.alias_id ORDER BY d.revision DESC LIMIT 1),'APPROVE')='APPROVE'`;
export class EntityKnowledge {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    context.requireOwner();
  }
  async list(limit: number, secret: string, now: Date, cursorValue?: string) {
    pageLimit(limit);
    const cursor = cursorValue
      ? await decodeCursor(
          cursorValue,
          this.context.ownerId,
          'entities:1',
          secret,
        )
      : null;
    const result = await this.db.batch([
      this.db
        .prepare(
          'SELECT COALESCE(MAX(seq),0) cut_seq FROM change_log WHERE owner_id=?',
        )
        .bind(this.context.ownerId),
      this.db
        .prepare(
          `SELECT e.*,(SELECT COALESCE(MAX(revision),0) FROM entity_alias_decisions d WHERE d.owner_id=e.owner_id AND d.entity_id=e.entity_id) revision FROM entities e WHERE e.owner_id=? AND (? IS NULL OR e.entity_id>?) ORDER BY e.entity_id LIMIT ?`,
        )
        .bind(
          this.context.ownerId,
          cursor?.id ?? null,
          cursor?.id ?? null,
          limit + 1,
        ),
    ]);
    const cut = String((result[0]!.results![0] as { cut_seq: number }).cut_seq);
    if (cursor && cursor.snapshot !== cut)
      throw new Error('READ_SNAPSHOT_CHANGED');
    const rows = result[1]!.results! as {
      entity_id: string;
      label: string;
      entity_type: string;
      resolution: string;
      revision: number;
    }[];
    const entities = rows.slice(0, limit);
    return {
      entities,
      cut_seq: cut,
      next_cursor:
        rows.length > limit
          ? await encodeCursor(
              {
                owner: this.context.ownerId,
                kind: 'entities:1',
                snapshot: cut,
                time: cursor?.time ?? now.toISOString(),
                id: entities.at(-1)!.entity_id,
              },
              secret,
            )
          : null,
    };
  }
  async detail(id: string) {
    const results = await this.db.batch([
      this.db
        .prepare('SELECT * FROM entities WHERE owner_id=? AND entity_id=?')
        .bind(this.context.ownerId, id),
      this.db
        .prepare(
          `SELECT a.alias_id,a.literal,CASE WHEN ${effectiveAlias} THEN 'APPROVED' ELSE 'REVOKED' END status FROM entity_aliases a WHERE a.owner_id=? AND a.entity_id=? ORDER BY a.alias_id LIMIT 51`,
        )
        .bind(this.context.ownerId, id),
      this.db
        .prepare(
          'SELECT decision_id,alias_id,revision,action,normalized_literal,language,reason,authored_by,recorded_at FROM entity_alias_decisions WHERE owner_id=? AND entity_id=? ORDER BY revision DESC LIMIT 51',
        )
        .bind(this.context.ownerId, id),
    ]);
    const entity = results[0]!.results![0] as
      | {
          entity_id: string;
          label: string;
          entity_type: string;
          resolution: string;
          created_at: string;
        }
      | undefined;
    if (!entity) throw new Error('NOT_FOUND');
    const history = results[2]!.results! as {
      decision_id: string;
      alias_id: string;
      revision: number;
      action: 'APPROVE' | 'REVOKE';
      normalized_literal: string;
      language: string | null;
      reason: string;
      authored_by: string;
      recorded_at: string;
    }[];
    return {
      entity,
      revision: history[0]?.revision ?? 0,
      aliases: (
        results[1]!.results! as {
          alias_id: string;
          literal: string;
          status: 'APPROVED' | 'REVOKED';
        }[]
      ).slice(0, 50),
      aliases_has_more: results[1]!.results!.length > 50,
      history: history.slice(0, 50),
      history_has_more: history.length > 50,
    };
  }
  async decide(
    input: {
      entity_id: string;
      literal: string;
      action: 'APPROVE' | 'REVOKE';
      reason: string;
      language: string | null;
      expected_revision: number;
      decision_id: string;
    },
    now: Date,
  ) {
    const literal = input.literal.normalize('NFC').trim(),
      reason = input.reason.trim();
    if (
      !literal ||
      new TextEncoder().encode(literal).length > 1024 ||
      !reason ||
      reason.length > 2000 ||
      !['APPROVE', 'REVOKE'].includes(input.action) ||
      !Number.isSafeInteger(input.expected_revision) ||
      input.expected_revision < 0 ||
      !/^[a-f0-9-]{36}$/.test(input.decision_id) ||
      (input.language !== null &&
        !/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8}){0,3}$/.test(input.language))
    )
      throw new Error('INVALID_ALIAS_DECISION');
    const normalized = {
      entity_id: input.entity_id,
      literal,
      reason,
      language: input.language,
      action: input.action,
      expected_revision: input.expected_revision,
      decision_id: input.decision_id,
    };
    const hash = await sha256(JSON.stringify(normalized));
    const existing = await this.db
      .prepare(
        'SELECT request_hash,revision FROM entity_alias_decisions WHERE owner_id=? AND decision_id=?',
      )
      .bind(this.context.ownerId, input.decision_id)
      .first<{ request_hash: string; revision: number }>();
    if (existing) {
      if (existing.request_hash !== hash)
        throw new Error('IDEMPOTENCY_CONFLICT');
      return { revision: existing.revision, duplicate: true };
    }
    const entity = await this.db
      .prepare(
        'SELECT entity_type FROM entities WHERE owner_id=? AND entity_id=?',
      )
      .bind(this.context.ownerId, input.entity_id)
      .first<{ entity_type: string }>();
    if (!entity) throw new Error('NOT_FOUND');
    const aliasId = await sha256(
      JSON.stringify({
        owner: this.context.ownerId,
        entity: input.entity_id,
        literal,
      }),
    );
    const guard = `COALESCE((SELECT MAX(revision) FROM entity_alias_decisions WHERE owner_id=? AND entity_id=?),0)=?`;
    const bindings = [
      this.context.ownerId,
      input.entity_id,
      input.expected_revision,
    ];
    if (
      input.action === 'REVOKE' &&
      !(await this.db
        .prepare(
          `SELECT 1 FROM entity_aliases a WHERE a.owner_id=? AND a.alias_id=? AND ${effectiveAlias}`,
        )
        .bind(this.context.ownerId, aliasId)
        .first())
    )
      throw new Error('INVALID_ALIAS_REVOCATION');
    const result = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO entity_aliases(owner_id,alias_id,entity_id,literal,created_at) SELECT ?,?,?,?,? WHERE ${guard} ON CONFLICT DO NOTHING`,
        )
        .bind(
          this.context.ownerId,
          aliasId,
          input.entity_id,
          literal,
          now.toISOString(),
          ...bindings,
        ),
      this.db
        .prepare(
          `INSERT INTO entity_alias_decisions(owner_id,decision_id,entity_id,alias_id,revision,action,normalized_literal,entity_type,language,reason,authored_by,request_hash,recorded_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard} RETURNING revision`,
        )
        .bind(
          this.context.ownerId,
          input.decision_id,
          input.entity_id,
          aliasId,
          input.expected_revision + 1,
          input.action,
          literal,
          entity.entity_type,
          input.language,
          reason,
          this.context.actorId,
          hash,
          now.toISOString(),
          ...bindings,
        ),
    ]);
    if (!result[1]!.results?.length) throw new Error('REVISION_CONFLICT');
    return { revision: input.expected_revision + 1, duplicate: false };
  }
}
