import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
export function effectiveEntity(alias: string) {
  if (!/^[a-z]+$/.test(alias)) throw new Error('INVALID_SQL_ALIAS');
  return `COALESCE((SELECT x.effective_entity_id FROM entity_identity_members x WHERE x.owner_id=${alias}.owner_id AND x.entity_id=${alias}.entity_id ORDER BY x.revision DESC LIMIT 1),${alias}.entity_id)`;
}
interface Member {
  entity_id: string;
  label: string;
  entity_type: string;
  effective_entity_id: string;
  identity_revision: number;
  alias_revision: number;
}
export interface IdentityProposal {
  action: 'MERGE' | 'SPLIT' | 'UNDO';
  source_entity_id: string;
  target_entity_id: string;
  parent_event_id: string | null;
  reason: string;
  expected: Member[];
  mappings: { entity_id: string; effective_entity_id: string }[];
  event_id: string;
  impact?: { observations: number; aliases: number };
}
export class EntityIdentity {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    context.requireOwner();
  }
  private async group(id: string) {
    const effective = effectiveEntity('e');
    const root = await this.db
      .prepare(
        `SELECT ${effective} root FROM entities e WHERE e.owner_id=? AND e.entity_id=?`,
      )
      .bind(this.context.ownerId, id)
      .first<{ root: string }>();
    if (!root) throw new Error('NOT_FOUND');
    const rows = (
      await this.db
        .prepare(
          `SELECT e.entity_id,e.label,e.entity_type,${effective} effective_entity_id,COALESCE((SELECT MAX(x.revision) FROM entity_identity_members x WHERE x.owner_id=e.owner_id AND x.entity_id=e.entity_id),0) identity_revision,COALESCE((SELECT MAX(d.revision) FROM entity_alias_decisions d WHERE d.owner_id=e.owner_id AND d.entity_id=e.entity_id),0) alias_revision FROM entities e WHERE e.owner_id=? AND ${effective}=? ORDER BY e.entity_id LIMIT 129`,
        )
        .bind(this.context.ownerId, root.root)
        .all<Member>()
    ).results;
    if (rows.length > 128) throw new Error('IDENTITY_GROUP_LIMIT');
    return { root: root.root, members: rows };
  }
  async preview(input: {
    action: 'MERGE' | 'SPLIT';
    source_entity_id: string;
    target_entity_id: string;
    reason: string;
  }) {
    const reason = input.reason.trim();
    if (
      !reason ||
      reason.length > 2000 ||
      !['MERGE', 'SPLIT'].includes(input.action)
    )
      throw new Error('INVALID_IDENTITY_CHANGE');
    const [source, target] = await Promise.all([
      this.group(input.source_entity_id),
      this.group(input.target_entity_id),
    ]);
    let mappings: IdentityProposal['mappings'];
    if (input.action === 'MERGE') {
      if (source.root === target.root)
        throw new Error('INVALID_IDENTITY_CYCLE');
      if (source.members[0]!.entity_type !== target.members[0]!.entity_type)
        throw new Error('INVALID_IDENTITY_TYPE');
      mappings = [...source.members, ...target.members].map((member) => ({
        entity_id: member.entity_id,
        effective_entity_id: target.root,
      }));
    } else {
      if (source.root !== target.root || input.source_entity_id === source.root)
        throw new Error('INVALID_IDENTITY_SPLIT');
      mappings = source.members.map((member) => ({
        entity_id: member.entity_id,
        effective_entity_id:
          member.entity_id === input.source_entity_id
            ? member.entity_id
            : source.root,
      }));
    }
    const expected = [
      ...new Map(
        [...source.members, ...target.members].map((member) => [
          member.entity_id,
          member,
        ]),
      ).values(),
    ].sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    if (expected.length > 128) throw new Error('IDENTITY_GROUP_LIMIT');
    const impact = await this.db
      .prepare(
        `SELECT (SELECT COUNT(DISTINCT observation_id) FROM observation_entities WHERE owner_id=? AND entity_id IN (SELECT json_extract(value,'$.entity_id') FROM json_each(?))) observations,(SELECT COUNT(*) FROM entity_aliases WHERE owner_id=? AND entity_id IN (SELECT json_extract(value,'$.entity_id') FROM json_each(?))) aliases`,
      )
      .bind(
        this.context.ownerId,
        JSON.stringify(expected),
        this.context.ownerId,
        JSON.stringify(expected),
      )
      .first<{ observations: number; aliases: number }>();
    return {
      action: input.action,
      source_entity_id: input.source_entity_id,
      target_entity_id: input.target_entity_id,
      parent_event_id: null,
      reason,
      expected,
      mappings: mappings.sort((a, b) => a.entity_id.localeCompare(b.entity_id)),
      event_id: crypto.randomUUID(),
      impact: impact!,
    } satisfies IdentityProposal;
  }
  async undoPreview(eventId: string, reason: string) {
    if (!reason.trim() || reason.length > 2000)
      throw new Error('INVALID_IDENTITY_CHANGE');
    const event = await this.db
      .prepare(
        'SELECT expected_json,source_entity_id,target_entity_id FROM entity_identity_events WHERE owner_id=? AND event_id=?',
      )
      .bind(this.context.ownerId, eventId)
      .first<{
        expected_json: string;
        source_entity_id: string;
        target_entity_id: string;
      }>();
    if (!event) throw new Error('NOT_FOUND');
    const previous = JSON.parse(event.expected_json) as Member[];
    const affected = new Set(previous.map((member) => member.entity_id));
    const produced = (
      await this.db
        .prepare(
          'SELECT entity_id,effective_entity_id FROM entity_identity_members WHERE owner_id=? AND event_id=?',
        )
        .bind(this.context.ownerId, eventId)
        .all<{ entity_id: string; effective_entity_id: string }>()
    ).results;
    const cache = new Map<
      string,
      Awaited<ReturnType<EntityIdentity['group']>>
    >();
    const expected: Member[] = [];
    for (const member of previous) {
      let group = cache.get(member.entity_id);
      if (!group) {
        group = await this.group(member.entity_id);
        for (const row of group.members) cache.set(row.entity_id, group);
      }
      const current = group.members.find(
        (row) => row.entity_id === member.entity_id,
      )!;
      if (
        current.effective_entity_id !==
          produced.find((row) => row.entity_id === member.entity_id)
            ?.effective_entity_id ||
        group.members.some((row) => !affected.has(row.entity_id))
      )
        throw new Error('IDENTITY_UNDO_DEPENDENCY');
      expected.push(current);
    }
    return {
      action: 'UNDO',
      source_entity_id: event.source_entity_id,
      target_entity_id: event.target_entity_id,
      parent_event_id: eventId,
      reason: reason.trim(),
      expected: expected.sort((a, b) => a.entity_id.localeCompare(b.entity_id)),
      mappings: previous
        .map((member) => ({
          entity_id: member.entity_id,
          effective_entity_id: member.effective_entity_id,
        }))
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id)),
      event_id: crypto.randomUUID(),
    } satisfies IdentityProposal;
  }
  async confirm(proposal: IdentityProposal, now: Date) {
    if (!/^[a-f0-9-]{36}$/.test(proposal.event_id))
      throw new Error('INVALID_IDENTITY_EVENT');
    const requestHash = await sha256(JSON.stringify(proposal));
    const prior = await this.db
      .prepare(
        'SELECT request_hash FROM entity_identity_events WHERE owner_id=? AND event_id=?',
      )
      .bind(this.context.ownerId, proposal.event_id)
      .first<string>('request_hash');
    if (prior) {
      if (prior !== requestHash) throw new Error('IDEMPOTENCY_CONFLICT');
      return { event_id: proposal.event_id, duplicate: true };
    }
    const fresh =
      proposal.action === 'UNDO'
        ? await this.undoPreview(proposal.parent_event_id!, proposal.reason)
        : await this.preview({
            action: proposal.action,
            source_entity_id: proposal.source_entity_id,
            target_entity_id: proposal.target_entity_id,
            reason: proposal.reason,
          });
    if (
      (
        [
          'action',
          'source_entity_id',
          'target_entity_id',
          'parent_event_id',
          'reason',
        ] as const
      ).some((key) => fresh[key] !== proposal[key]) ||
      JSON.stringify(fresh.expected) !== JSON.stringify(proposal.expected) ||
      JSON.stringify(fresh.mappings) !== JSON.stringify(proposal.mappings)
    )
      throw new Error('REVISION_CONFLICT');
    const expected = JSON.stringify(proposal.expected);
    const guard = `NOT EXISTS(SELECT 1 FROM json_each(?) p WHERE COALESCE((SELECT MAX(x.revision) FROM entity_identity_members x WHERE x.owner_id=? AND x.entity_id=json_extract(p.value,'$.entity_id')),0)!=json_extract(p.value,'$.identity_revision') OR COALESCE((SELECT MAX(d.revision) FROM entity_alias_decisions d WHERE d.owner_id=? AND d.entity_id=json_extract(p.value,'$.entity_id')),0)!=json_extract(p.value,'$.alias_revision'))`;
    const result = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO entity_identity_events SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard} RETURNING event_id`,
        )
        .bind(
          this.context.ownerId,
          proposal.event_id,
          proposal.action,
          proposal.source_entity_id,
          proposal.target_entity_id,
          proposal.parent_event_id,
          proposal.reason,
          this.context.actorId,
          expected,
          requestHash,
          now.toISOString(),
          expected,
          this.context.ownerId,
          this.context.ownerId,
        ),
      this.db
        .prepare(
          `INSERT INTO entity_identity_members SELECT ?,?,json_extract(p.value,'$.entity_id'),json_extract(p.value,'$.effective_entity_id'),json_extract(s.value,'$.identity_revision')+1 FROM json_each(?) p JOIN json_each(?) s ON json_extract(s.value,'$.entity_id')=json_extract(p.value,'$.entity_id') WHERE EXISTS(SELECT 1 FROM entity_identity_events WHERE owner_id=? AND event_id=?) AND NOT EXISTS(SELECT 1 FROM entity_identity_members WHERE owner_id=? AND event_id=?)`,
        )
        .bind(
          this.context.ownerId,
          proposal.event_id,
          JSON.stringify(proposal.mappings),
          expected,
          this.context.ownerId,
          proposal.event_id,
          this.context.ownerId,
          proposal.event_id,
        ),
    ]);
    if (!result[0]!.results?.length) {
      const replay = await this.db
        .prepare(
          'SELECT request_hash FROM entity_identity_events WHERE owner_id=? AND event_id=?',
        )
        .bind(this.context.ownerId, proposal.event_id)
        .first<string>('request_hash');
      if (replay === requestHash)
        return { event_id: proposal.event_id, duplicate: true };
      throw new Error('REVISION_CONFLICT');
    }
    return { event_id: proposal.event_id, duplicate: false };
  }
}
