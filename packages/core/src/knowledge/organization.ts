import {
  assertContext,
  type AccessContext,
  type Database,
  type Statement,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
type Action = 'SPACE' | 'MEMBERSHIP' | 'REVIEW' | 'INSIGHT';
export interface SpaceMembership {
  space_id: string;
  active: number;
  revision: number;
  name: string;
  space_active: number;
}
export interface ManualInsight {
  insight_id: string;
  text: string;
  authored_by: string;
  active: number;
  revision: number;
  created_at: string;
  updated_at: string;
}
export class KnowledgeOrganization {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    context.requireOwner();
  }
  private async item(id: string) {
    if (
      !(await this.db
        .prepare('SELECT 1 FROM items WHERE owner_id=? AND item_id=?')
        .bind(this.context.ownerId, id)
        .first())
    )
      throw new Error('NOT_FOUND');
  }
  private async replay(id: string, hash: string) {
    const row = await this.db
      .prepare(
        'SELECT request_hash,after_json FROM organization_mutations WHERE owner_id=? AND mutation_id=?',
      )
      .bind(this.context.ownerId, id)
      .first<{ request_hash: string; after_json: string }>();
    if (!row) return null;
    if (row.request_hash !== hash) throw new Error('IDEMPOTENCY_CONFLICT');
    return {
      state: JSON.parse(row.after_json) as Record<string, unknown>,
      duplicate: true,
    };
  }
  private async commit(
    action: Action,
    target: string,
    mutation: string,
    request: Record<string, unknown>,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    predicate: string,
    bindings: (string | number | null)[],
    effects: (
      guard: string,
      bindings: (string | number | null)[],
    ) => Statement[],
    now: Date,
  ) {
    if (!/^[a-f0-9-]{36}$/.test(mutation))
      throw new Error('INVALID_MUTATION_ID');
    const hash = await sha256(JSON.stringify({ action, target, ...request }));
    const replay = await this.replay(mutation, hash);
    if (replay) return replay;
    const writeToken = crypto.randomUUID();
    const guard =
      'EXISTS(SELECT 1 FROM organization_mutations WHERE owner_id=? AND mutation_id=? AND write_token=?)';
    const guardBindings = [this.context.ownerId, mutation, writeToken];
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO organization_mutations SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${predicate} ON CONFLICT(owner_id,mutation_id) DO NOTHING RETURNING mutation_id`,
        )
        .bind(
          this.context.ownerId,
          mutation,
          action,
          target,
          hash,
          writeToken,
          JSON.stringify(before),
          JSON.stringify(after),
          this.context.actorId,
          now.toISOString(),
          ...bindings,
        ),
      ...effects(guard, guardBindings),
    ]);
    if (results[0]!.results!.length) return { state: after, duplicate: false };
    const raced = await this.replay(mutation, hash);
    if (raced) return raced;
    throw new Error('REVISION_CONFLICT');
  }
  async spaces() {
    return (
      await this.db
        .prepare(
          'SELECT space_id,name,active,revision FROM spaces WHERE owner_id=? ORDER BY space_id LIMIT 201',
        )
        .bind(this.context.ownerId)
        .all<{
          space_id: string;
          name: string;
          active: number;
          revision: number;
        }>()
    ).results;
  }
  async space(
    input: {
      space_id: string;
      name: string;
      active: boolean;
      expected_revision: number;
      mutation_id: string;
    },
    now: Date,
  ) {
    if (
      !/^[a-f0-9-]{36}$/.test(input.space_id) ||
      !input.name.trim() ||
      input.name.trim().length > 120 ||
      typeof input.active !== 'boolean' ||
      !Number.isSafeInteger(input.expected_revision) ||
      input.expected_revision < 0
    )
      throw new Error('INVALID_SPACE');
    const before = await this.db
      .prepare(
        'SELECT space_id,name,active,revision FROM spaces WHERE owner_id=? AND space_id=?',
      )
      .bind(this.context.ownerId, input.space_id)
      .first<{
        space_id: string;
        name: string;
        active: number;
        revision: number;
      }>();
    const after = {
      space_id: input.space_id,
      name: input.name.trim(),
      active: Number(input.active),
      revision: input.expected_revision + 1,
    };
    return this.commit(
      'SPACE',
      input.space_id,
      input.mutation_id,
      { ...input, name: after.name },
      before,
      after,
      'COALESCE((SELECT revision FROM spaces WHERE owner_id=? AND space_id=?),0)=?',
      [this.context.ownerId, input.space_id, input.expected_revision],
      (guard, bindings) => [
        this.db
          .prepare(
            `INSERT INTO spaces SELECT ?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(owner_id,space_id) DO UPDATE SET name=excluded.name,active=excluded.active,revision=excluded.revision,updated_at=excluded.updated_at`,
          )
          .bind(
            this.context.ownerId,
            input.space_id,
            after.name,
            after.active,
            after.revision,
            now.toISOString(),
            now.toISOString(),
            ...bindings,
          ),
      ],
      now,
    );
  }
  async read(itemId: string) {
    await this.item(itemId);
    const result = await this.db.batch([
      this.db
        .prepare(
          `SELECT r.revision,r.saved,r.last_opened,r.read_at,r.reviewed_run_id,r.updated_at,s.accepted_run_id FROM items i LEFT JOIN review_state r ON r.owner_id=i.owner_id AND r.item_id=i.item_id LEFT JOIN active_analysis_selections s ON s.owner_id=i.owner_id AND s.item_id=i.item_id WHERE i.owner_id=? AND i.item_id=?`,
        )
        .bind(this.context.ownerId, itemId),
      this.db
        .prepare(
          'SELECT m.space_id,m.active,m.revision,s.name,s.active space_active FROM item_spaces m JOIN spaces s ON s.owner_id=m.owner_id AND s.space_id=m.space_id WHERE m.owner_id=? AND m.item_id=? ORDER BY m.space_id LIMIT 201',
        )
        .bind(this.context.ownerId, itemId),
      this.db
        .prepare(
          'SELECT insight_id,text,authored_by,active,revision,created_at,updated_at FROM insights WHERE owner_id=? AND item_id=? ORDER BY created_at DESC,insight_id DESC LIMIT 51',
        )
        .bind(this.context.ownerId, itemId),
      this.db
        .prepare(
          'SELECT x.insight_id,x.observation_id FROM insight_observations x JOIN insights n ON n.owner_id=x.owner_id AND n.insight_id=x.insight_id WHERE n.owner_id=? AND n.item_id=? ORDER BY x.insight_id,x.observation_id LIMIT 1001',
        )
        .bind(this.context.ownerId, itemId),
    ]);
    const state = result[0]!.results![0] as {
      revision: number | null;
      saved: number | null;
      last_opened: string | null;
      read_at: string | null;
      reviewed_run_id: string | null;
      accepted_run_id: string | null;
    };
    return {
      review: {
        ...state,
        revision: state.revision ?? 0,
        saved: state.saved ?? 0,
        updated:
          !!state.accepted_run_id &&
          !!state.reviewed_run_id &&
          state.accepted_run_id !== state.reviewed_run_id,
      },
      memberships: result[1]!.results!.slice(
        0,
        200,
      ) as unknown as SpaceMembership[],
      memberships_has_more: result[1]!.results!.length > 200,
      insights: result[2]!.results!.slice(0, 50) as unknown as ManualInsight[],
      insights_has_more: result[2]!.results!.length > 50,
      observation_refs: result[3]!.results!.slice(0, 1000) as unknown as {
        insight_id: string;
        observation_id: string;
      }[],
      observation_refs_has_more: result[3]!.results!.length > 1000,
    };
  }
  async membership(
    input: {
      item_id: string;
      space_id: string;
      active: boolean;
      expected_revision: number;
      mutation_id: string;
    },
    now: Date,
  ) {
    await this.item(input.item_id);
    if (
      typeof input.active !== 'boolean' ||
      !Number.isSafeInteger(input.expected_revision) ||
      input.expected_revision < 0
    )
      throw new Error('INVALID_MEMBERSHIP');
    const space = await this.db
      .prepare('SELECT active FROM spaces WHERE owner_id=? AND space_id=?')
      .bind(this.context.ownerId, input.space_id)
      .first<{ active: number }>();
    if (!space || (input.active && !space.active)) throw new Error('NOT_FOUND');
    const before = await this.db
      .prepare(
        'SELECT item_id,space_id,active,revision FROM item_spaces WHERE owner_id=? AND item_id=? AND space_id=?',
      )
      .bind(this.context.ownerId, input.item_id, input.space_id)
      .first<{
        item_id: string;
        space_id: string;
        active: number;
        revision: number;
      }>();
    const unchanged = before?.active === Number(input.active);
    const after = {
      item_id: input.item_id,
      space_id: input.space_id,
      active: Number(input.active),
      revision: input.expected_revision + (unchanged ? 0 : 1),
    };
    return this.commit(
      'MEMBERSHIP',
      input.item_id,
      input.mutation_id,
      input,
      before,
      after,
      'COALESCE((SELECT revision FROM item_spaces WHERE owner_id=? AND item_id=? AND space_id=?),0)=? AND EXISTS(SELECT 1 FROM spaces WHERE owner_id=? AND space_id=? AND (?=0 OR active=1))',
      [
        this.context.ownerId,
        input.item_id,
        input.space_id,
        input.expected_revision,
        this.context.ownerId,
        input.space_id,
        Number(input.active),
      ],
      (guard, bindings) =>
        unchanged
          ? []
          : [
              this.db
                .prepare(
                  `INSERT INTO item_spaces SELECT ?,?,?,?,?,? WHERE ${guard} ON CONFLICT(owner_id,item_id,space_id) DO UPDATE SET active=excluded.active,revision=excluded.revision,updated_at=excluded.updated_at`,
                )
                .bind(
                  this.context.ownerId,
                  input.item_id,
                  input.space_id,
                  after.active,
                  after.revision,
                  now.toISOString(),
                  ...bindings,
                ),
            ],
      now,
    );
  }
  async review(
    input: {
      item_id: string;
      action: 'SAVE' | 'UNSAVE' | 'OPEN' | 'READ' | 'REVIEW';
      reviewed_run_id: string | null;
      expected_revision: number;
      mutation_id: string;
    },
    now: Date,
  ) {
    await this.item(input.item_id);
    if (
      !['SAVE', 'UNSAVE', 'OPEN', 'READ', 'REVIEW'].includes(input.action) ||
      !Number.isSafeInteger(input.expected_revision) ||
      input.expected_revision < 0 ||
      (input.action !== 'REVIEW' && input.reviewed_run_id !== null)
    )
      throw new Error('INVALID_REVIEW_STATE');
    if (
      input.action === 'REVIEW' &&
      (!input.reviewed_run_id ||
        !(await this.db
          .prepare(
            "SELECT 1 FROM analysis_runs WHERE owner_id=? AND item_id=? AND run_id=? AND state='ACCEPTED'",
          )
          .bind(this.context.ownerId, input.item_id, input.reviewed_run_id)
          .first()))
    )
      throw new Error('INVALID_REVIEWED_RUN');
    const before = await this.db
      .prepare(
        'SELECT saved,last_opened,read_at,reviewed_run_id,revision FROM review_state WHERE owner_id=? AND item_id=?',
      )
      .bind(this.context.ownerId, input.item_id)
      .first<{
        saved: number;
        last_opened: string | null;
        read_at: string | null;
        reviewed_run_id: string | null;
        revision: number;
      }>();
    const after = {
      item_id: input.item_id,
      saved: before?.saved ?? 0,
      last_opened: before?.last_opened ?? null,
      read_at: before?.read_at ?? null,
      reviewed_run_id: before?.reviewed_run_id ?? null,
      revision: input.expected_revision + 1,
    };
    if (input.action === 'SAVE' || input.action === 'UNSAVE')
      after.saved = Number(input.action === 'SAVE');
    if (input.action === 'OPEN') after.last_opened = now.toISOString();
    if (input.action === 'READ') after.read_at = now.toISOString();
    if (input.action === 'REVIEW')
      after.reviewed_run_id = input.reviewed_run_id;
    return this.commit(
      'REVIEW',
      input.item_id,
      input.mutation_id,
      input,
      before,
      after,
      'COALESCE((SELECT revision FROM review_state WHERE owner_id=? AND item_id=?),0)=?',
      [this.context.ownerId, input.item_id, input.expected_revision],
      (guard, bindings) => [
        this.db
          .prepare(
            `INSERT INTO review_state SELECT ?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(owner_id,item_id) DO UPDATE SET revision=excluded.revision,saved=excluded.saved,last_opened=excluded.last_opened,read_at=excluded.read_at,reviewed_run_id=excluded.reviewed_run_id,updated_at=excluded.updated_at`,
          )
          .bind(
            this.context.ownerId,
            input.item_id,
            after.revision,
            after.saved,
            after.last_opened,
            after.read_at,
            after.reviewed_run_id,
            now.toISOString(),
            ...bindings,
          ),
      ],
      now,
    );
  }
  async insight(
    input: {
      insight_id: string;
      item_id: string;
      text: string;
      active: boolean;
      observation_ids: string[];
      expected_revision: number;
      mutation_id: string;
    },
    now: Date,
  ) {
    await this.item(input.item_id);
    if (
      !/^[a-f0-9-]{36}$/.test(input.insight_id) ||
      !input.text.trim() ||
      new TextEncoder().encode(input.text).length > 20000 ||
      typeof input.active !== 'boolean' ||
      !Number.isSafeInteger(input.expected_revision) ||
      input.expected_revision < 0 ||
      !Array.isArray(input.observation_ids) ||
      input.observation_ids.length > 20 ||
      input.observation_ids.some(
        (id) => typeof id !== 'string' || !id || id.length > 128,
      ) ||
      new Set(input.observation_ids).size !== input.observation_ids.length
    )
      throw new Error('INVALID_INSIGHT');
    const refs = [...input.observation_ids].sort();
    for (const id of refs)
      if (
        !(await this.db
          .prepare(
            "SELECT 1 FROM observations o JOIN analysis_runs r ON r.owner_id=o.owner_id AND r.run_id=o.run_id AND r.state='ACCEPTED' WHERE o.owner_id=? AND r.item_id=? AND o.observation_id=?",
          )
          .bind(this.context.ownerId, input.item_id, id)
          .first())
      )
        throw new Error('INVALID_INSIGHT_OBSERVATION');
    const before = await this.db
      .prepare(
        'SELECT insight_id,item_id,text,active,revision FROM insights WHERE owner_id=? AND insight_id=?',
      )
      .bind(this.context.ownerId, input.insight_id)
      .first<{
        insight_id: string;
        item_id: string;
        text: string;
        active: number;
        revision: number;
      }>();
    if (before && before.item_id !== input.item_id)
      throw new Error('INVALID_INSIGHT_ITEM');
    const beforeRefs = before
      ? (
          await this.db
            .prepare(
              'SELECT observation_id FROM insight_observations WHERE owner_id=? AND insight_id=? ORDER BY observation_id',
            )
            .bind(this.context.ownerId, input.insight_id)
            .all<{ observation_id: string }>()
        ).results.map((row) => row.observation_id)
      : [];
    const after = {
      insight_id: input.insight_id,
      item_id: input.item_id,
      text: input.text,
      active: Number(input.active),
      observation_ids: refs,
      revision: input.expected_revision + 1,
      authored_by: this.context.ownerId,
    };
    return this.commit(
      'INSIGHT',
      input.item_id,
      input.mutation_id,
      { ...input, observation_ids: refs },
      before ? { ...before, observation_ids: beforeRefs } : null,
      after,
      'COALESCE((SELECT revision FROM insights WHERE owner_id=? AND insight_id=?),0)=?',
      [this.context.ownerId, input.insight_id, input.expected_revision],
      (guard, bindings) => [
        this.db
          .prepare(
            `INSERT INTO insights SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(owner_id,insight_id) DO UPDATE SET text=excluded.text,active=excluded.active,revision=excluded.revision,updated_at=excluded.updated_at`,
          )
          .bind(
            this.context.ownerId,
            input.insight_id,
            input.item_id,
            input.text,
            this.context.ownerId,
            after.active,
            after.revision,
            now.toISOString(),
            now.toISOString(),
            ...bindings,
          ),
        this.db
          .prepare(
            `DELETE FROM insight_observations WHERE owner_id=? AND insight_id=? AND ${guard}`,
          )
          .bind(this.context.ownerId, input.insight_id, ...bindings),
        ...refs.map((id) =>
          this.db
            .prepare(
              `INSERT INTO insight_observations SELECT ?,?,? WHERE ${guard}`,
            )
            .bind(this.context.ownerId, input.insight_id, id, ...bindings),
        ),
      ],
      now,
    );
  }
}
