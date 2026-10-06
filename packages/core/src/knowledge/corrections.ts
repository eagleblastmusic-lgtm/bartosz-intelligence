import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
export type CorrectionKind = 'OBSERVATION_TEXT' | 'ENTITY_LABEL';
export class KnowledgeCorrections {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    context.requireOwner();
  }
  async read(kind: CorrectionKind, id: string) {
    if (
      !['OBSERVATION_TEXT', 'ENTITY_LABEL'].includes(kind) ||
      !id ||
      id.length > 128
    )
      throw new Error('INVALID_CORRECTION_TARGET');
    let raw: { value: string; hash: string } | null;
    if (kind === 'OBSERVATION_TEXT')
      raw = await this.db
        .prepare(
          `SELECT json_extract(o.row_json,'$.content_pl') value,o.row_hash hash FROM observations o JOIN analysis_runs r ON r.owner_id=o.owner_id AND r.run_id=o.run_id AND r.state='ACCEPTED' WHERE o.owner_id=? AND o.observation_id=?`,
        )
        .bind(this.context.ownerId, id)
        .first<{ value: string; hash: string }>();
    else {
      const row = await this.db
        .prepare('SELECT label FROM entities WHERE owner_id=? AND entity_id=?')
        .bind(this.context.ownerId, id)
        .first<{ label: string }>();
      raw = row ? { value: row.label, hash: await sha256(row.label) } : null;
    }
    if (!raw || typeof raw.value !== 'string') throw new Error('NOT_FOUND');
    const history = (
      await this.db
        .prepare(
          'SELECT correction_id,revision,target_hash,original_value,old_value,new_value,action,reason,authored_by,recorded_at FROM correction_overlays WHERE owner_id=? AND target_kind=? AND target_id=? ORDER BY revision DESC LIMIT 51',
        )
        .bind(this.context.ownerId, kind, id)
        .all<{
          correction_id: string;
          revision: number;
          target_hash: string;
          original_value: string;
          old_value: string;
          new_value: string;
          action: 'APPLY' | 'REVERT';
          reason: string;
          authored_by: string;
          recorded_at: string;
        }>()
    ).results;
    for (let index = 0; index < history.length; index++) {
      const event = history[index]!;
      const previous = history[index + 1];
      if (
        event.target_hash !== raw.hash ||
        event.original_value !== raw.value ||
        event.authored_by !== this.context.ownerId ||
        (event.action === 'REVERT' && event.new_value !== raw.value) ||
        (previous &&
          (event.revision !== previous.revision + 1 ||
            event.old_value !== previous.new_value)) ||
        (event.revision === 1 && event.old_value !== raw.value)
      )
        throw new Error('CORRECTION_INTEGRITY_INVALID');
    }
    return {
      target_kind: kind,
      target_id: id,
      target_hash: raw.hash,
      original_value: raw.value,
      effective_value: history[0]?.new_value ?? raw.value,
      revision: history[0]?.revision ?? 0,
      history: history.slice(0, 50),
      history_has_more: history.length > 50,
    };
  }
  async apply(
    input: {
      target_kind: CorrectionKind;
      target_id: string;
      expected_revision: number;
      target_hash: string;
      old_value: string;
      new_value: string;
      action: 'APPLY' | 'REVERT';
      reason: string;
      correction_id: string;
    },
    now: Date,
  ) {
    if (
      !Number.isSafeInteger(input.expected_revision) ||
      input.expected_revision < 0 ||
      !/^[a-f0-9-]{36}$/.test(input.correction_id) ||
      !['APPLY', 'REVERT'].includes(input.action) ||
      !input.reason.trim() ||
      input.reason.length > 2000 ||
      !input.new_value.trim() ||
      new TextEncoder().encode(input.new_value).length > 20000
    )
      throw new Error('INVALID_CORRECTION');
    const hash = await sha256(
      JSON.stringify({
        target_kind: input.target_kind,
        target_id: input.target_id,
        expected_revision: input.expected_revision,
        target_hash: input.target_hash,
        old_value: input.old_value,
        new_value: input.new_value,
        action: input.action,
        reason: input.reason.trim(),
        correction_id: input.correction_id,
      }),
    );
    const replay = await this.db
      .prepare(
        'SELECT request_hash,revision FROM correction_overlays WHERE owner_id=? AND correction_id=?',
      )
      .bind(this.context.ownerId, input.correction_id)
      .first<{ request_hash: string; revision: number }>();
    if (replay) {
      if (replay.request_hash !== hash) throw new Error('IDEMPOTENCY_CONFLICT');
      return { revision: replay.revision, duplicate: true };
    }
    const target = await this.read(input.target_kind, input.target_id);
    if (
      target.revision !== input.expected_revision ||
      target.target_hash !== input.target_hash ||
      target.effective_value !== input.old_value
    )
      throw new Error('REVISION_CONFLICT');
    if (input.action === 'REVERT' && input.new_value !== target.original_value)
      throw new Error('INVALID_CORRECTION_REVERT');
    const result = await this.db
      .prepare(
        `INSERT INTO correction_overlays SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE COALESCE((SELECT MAX(revision) FROM correction_overlays WHERE owner_id=? AND target_kind=? AND target_id=?),0)=? RETURNING revision`,
      )
      .bind(
        this.context.ownerId,
        input.correction_id,
        input.target_kind,
        input.target_id,
        input.expected_revision + 1,
        input.target_hash,
        target.original_value,
        input.old_value,
        input.new_value,
        input.action,
        input.reason.trim(),
        this.context.actorId,
        hash,
        now.toISOString(),
        this.context.ownerId,
        input.target_kind,
        input.target_id,
        input.expected_revision,
      )
      .all<{ revision: number }>();
    if (!result.results.length) throw new Error('REVISION_CONFLICT');
    return { revision: input.expected_revision + 1, duplicate: false };
  }
}
