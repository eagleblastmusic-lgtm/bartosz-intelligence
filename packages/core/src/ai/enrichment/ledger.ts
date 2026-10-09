import {
  assertContext,
  type AccessContext,
  type Database,
  type Statement,
} from '../../db/boundary.js';
import { sha256 } from '../../auth/crypto.js';
import { leasePredicate } from '../../jobs/lease-guard.js';
import type { LeaseToken } from '../../../../contracts/src/jobs.js';
import type { enrichEconomy } from './canonical.js';
import type { ApprovedAlias } from './entities.js';
import { effectiveAlias } from '../../knowledge/entities.js';
import { effectiveEntity } from '../../knowledge/identity.js';
import { validateCanonical } from '../repair/validate.js';
import { acceptedCorrectedSource } from '../../transcript/corrected-authority.js';
type Enriched = Awaited<ReturnType<typeof enrichEconomy>>;
export class IntelligenceLedger {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async aliases(token: LeaseToken, now: Date): Promise<ApprovedAlias[]> {
    const guard = leasePredicate(
      this.context,
      token,
      now.toISOString(),
      'ANALYZE',
    );
    return (
      await this.db
        .prepare(
          `SELECT a.owner_id,${effectiveEntity('a')} entity_id,e.entity_type,a.literal,(SELECT d.language FROM entity_alias_decisions d WHERE d.owner_id=a.owner_id AND d.alias_id=a.alias_id ORDER BY d.revision DESC LIMIT 1) language FROM entity_aliases a JOIN entities e ON e.owner_id=a.owner_id AND e.entity_id=a.entity_id WHERE a.owner_id=? AND ${effectiveAlias} AND ${guard.predicate}`,
        )
        .bind(this.context.ownerId, ...guard.bindings)
        .all<ApprovedAlias>()
    ).results;
  }
  async read(runId: string) {
    this.context.requireOwner();
    return (
      await this.db
        .prepare(
          `SELECT o.observation_id,o.kind,o.row_json,o.row_hash FROM observations o JOIN analysis_runs r ON r.owner_id=o.owner_id AND r.run_id=o.run_id WHERE o.owner_id=? AND o.run_id=? AND r.state='ACCEPTED' ORDER BY o.observation_id`,
        )
        .bind(this.context.ownerId, runId)
        .all()
    ).results;
  }
  async prepare(value: Enriched, runId: string, token: LeaseToken, now: Date) {
    const guard = leasePredicate(
      this.context,
      token,
      now.toISOString(),
      'ANALYZE',
    );
    if (
      value.source_pin.artifact_id !== value.canonical.source_artifact_id ||
      !validateCanonical(value.canonical) ||
      (await sha256(JSON.stringify(value.canonical))) !==
        value.canonical_hash ||
      JSON.stringify(value.observation_rows) !==
        JSON.stringify([
          ...value.canonical.claims,
          ...value.canonical.stance,
          ...value.canonical.predictions,
          ...value.canonical.usage,
          ...value.canonical.recommendations,
          ...value.canonical.uncertainties,
          ...value.canonical.contradictions,
        ])
    )
      throw new Error('INVALID_LEDGER_PROJECTION');
    const baseRows = [
      ...value.canonical.claims,
      ...value.canonical.stance,
      ...value.canonical.predictions,
      ...value.canonical.usage,
      ...value.canonical.recommendations,
      ...value.canonical.uncertainties,
    ];
    const byId = new Map(baseRows.map((row) => [row.observation_id, row]));
    const sameSet = (left: readonly string[], right: readonly string[]) =>
      JSON.stringify([...new Set(left)].sort()) ===
      JSON.stringify([...new Set(right)].sort());
    if (
      new Set(value.observation_rows.map((row) => row.observation_id)).size !==
      value.observation_rows.length
    )
      throw new Error('INVALID_LEDGER_PROJECTION');
    for (const relation of value.canonical.contradictions) {
      const left = byId.get(relation.relation_refs[0]!),
        right = byId.get(relation.relation_refs[1]!);
      if (
        !left ||
        !right ||
        left.observation_id === right.observation_id ||
        relation.relation_refs.length !== 2 ||
        !left.evidence_ids.length ||
        !right.evidence_ids.length ||
        relation.kind !== 'CONTRADICTION' ||
        relation.attribution !== 'UNCLEAR' ||
        relation.epistemic_status !== 'SOURCE_INFERENCE' ||
        !sameSet(relation.evidence_ids, [
          ...left.evidence_ids,
          ...right.evidence_ids,
        ]) ||
        !sameSet(
          relation.entity_refs,
          [
            ...left.entity_refs,
            left.subject_ref,
            left.target_ref,
            ...right.entity_refs,
            right.subject_ref,
            right.target_ref,
          ].filter((id): id is string => id !== null),
        ) ||
        [...left.qualifiers, ...right.qualifiers].some(
          (qualifier) => !relation.qualifiers.includes(qualifier),
        )
      )
        throw new Error('INVALID_RELATION_PROJECTION');
    }
    const source = await this.db
      .prepare(
        `SELECT a.artifact_id,a.kind,r.input_snapshot_json FROM artifacts a JOIN analysis_runs r ON r.owner_id=a.owner_id AND r.item_id=a.item_id WHERE a.owner_id=? AND a.artifact_id=? AND a.item_id=? AND a.state='VERIFIED' AND a.content_hash=? AND EXISTS(SELECT 1 FROM artifacts m WHERE m.owner_id=a.owner_id AND m.item_id=a.item_id AND m.kind='SEGMENT_MAP' AND m.state='VERIFIED' AND m.content_hash=? AND ((a.kind='SOURCE_ORIGINAL' AND m.original_ref=a.artifact_id AND (m.producer_version='source-normalizer:1' OR (length(a.producer_version)=length('yt-dlp@2026.08.19+yt-dlp-ejs@0.8.0:archive-source:1:')+64 AND substr(a.producer_version,1,length('yt-dlp@2026.08.19+yt-dlp-ejs@0.8.0:archive-source:1:'))='yt-dlp@2026.08.19+yt-dlp-ejs@0.8.0:archive-source:1:' AND m.producer_version=replace(a.producer_version,'yt-dlp@2026.08.19+yt-dlp-ejs@0.8.0','source-normalizer:1')))) OR (a.kind='NORMALIZED' AND a.producer_version='owner-source-correction:1' AND m.original_ref=a.original_ref AND m.producer_version=a.producer_version))) AND r.run_id=? AND r.job_id=? AND r.state='CANDIDATE' AND ${guard.predicate}`,
      )
      .bind(
        this.context.ownerId,
        value.canonical.source_artifact_id,
        value.canonical.item_id,
        value.source_pin.source_hash,
        value.source_pin.manifest_hash,
        runId,
        token.job_id,
        ...guard.bindings,
      )
      .first<{
        artifact_id: string;
        kind: string;
        input_snapshot_json: string;
      }>();
    if (!source) throw new Error('LEDGER_SOURCE_OR_FENCE_MISMATCH');
    if (source.kind === 'NORMALIZED') {
      const snapshot = JSON.parse(source.input_snapshot_json) as {
        run_id: string;
        correction?: unknown;
      };
      if (!snapshot.correction)
        throw new Error('LEDGER_SOURCE_OR_FENCE_MISMATCH');
      const authority = await acceptedCorrectedSource(
        this.db,
        this.context,
        snapshot.run_id,
      );
      if (
        JSON.stringify(authority) !== JSON.stringify(snapshot) ||
        authority.source_artifact_id !== value.canonical.source_artifact_id ||
        authority.source_hash !== value.source_pin.source_hash ||
        authority.manifest_hash !== value.source_pin.manifest_hash
      )
        throw new Error('LEDGER_SOURCE_OR_FENCE_MISMATCH');
    }
    for (const entity of value.entity_resolutions)
      if (
        entity.resolution === 'APPROVED_ALIAS' &&
        !(await this.db
          .prepare(
            `SELECT 1 FROM entity_aliases a JOIN entities e ON e.owner_id=a.owner_id AND e.entity_id=a.entity_id WHERE a.owner_id=? AND a.entity_id=? AND a.literal=? AND e.entity_type=?`,
          )
          .bind(
            this.context.ownerId,
            entity.entity_id,
            entity.label,
            entity.entity_type,
          )
          .first())
      )
        throw new Error('UNAPPROVED_ENTITY_MAPPING');
    if (value.evidence_snapshots.some((row) => row.canonical.quote_pl !== null))
      throw new Error('HELPER_APPROVAL_NOT_CONNECTED');
    const canonicalEvidence = new Map(
      value.canonical.evidence.map((row) => [row.evidence_id, row]),
    );
    if (
      canonicalEvidence.size !== value.evidence_snapshots.length ||
      new Set(value.evidence_snapshots.map((row) => row.canonical.evidence_id))
        .size !== value.evidence_snapshots.length ||
      value.canonical.entities.some(
        (entity) =>
          !value.entity_resolutions.some(
            (resolution) =>
              resolution.entity_id === entity.entity_id &&
              resolution.entity_type === entity.entity_type &&
              resolution.label === entity.label,
          ),
      )
    )
      throw new Error('INVALID_LEDGER_PROJECTION');
    for (const row of value.evidence_snapshots)
      if (
        JSON.stringify(canonicalEvidence.get(row.canonical.evidence_id)) !==
          JSON.stringify(row.canonical) ||
        row.canonical.source_artifact_id !==
          value.canonical.source_artifact_id ||
        row.canonical.source_hash !== value.source_pin.source_hash ||
        row.anchor_snapshot.manifest_hash !== value.source_pin.manifest_hash ||
        (await sha256(row.canonical.quote_original)) !==
          row.canonical.quote_hash
      )
        throw new Error('INVALID_EVIDENCE_PROJECTION');
    const entityRows = value.entity_resolutions.filter(
      (row) => row.resolution !== 'APPROVED_ALIAS',
    );
    const evidenceRows = value.evidence_snapshots.map((row) => {
      const {
        quote_original: original,
        quote_pl: polish,
        ...metadata
      } = row.canonical;
      void original;
      void polish;
      return {
        ...metadata,
        source_start: row.anchor_snapshot.source_start,
        source_end: row.anchor_snapshot.source_end,
        segment_ids_json: JSON.stringify(row.canonical.segment_ids),
        anchor_snapshot_json: JSON.stringify(row.anchor_snapshot),
      };
    });
    const observations = await Promise.all(
      value.observation_rows.map(async (row) => ({
        observation_id: row.observation_id,
        kind: row.kind,
        row_json: JSON.stringify(row),
        row_hash: await sha256(JSON.stringify(row)),
      })),
    );
    const evidenceJoins = value.observation_rows.flatMap((row) =>
      row.evidence_ids.map((id) => ({
        observation_id: row.observation_id,
        evidence_id: id,
      })),
    );
    const entityJoins = value.observation_rows.flatMap((row) => [
      ...row.entity_refs.map((id) => ({
        observation_id: row.observation_id,
        entity_id: id,
        role: 'MENTION',
      })),
      ...(row.subject_ref
        ? [
            {
              observation_id: row.observation_id,
              entity_id: row.subject_ref,
              role: 'SUBJECT',
            },
          ]
        : []),
      ...(row.target_ref
        ? [
            {
              observation_id: row.observation_id,
              entity_id: row.target_ref,
              role: 'TARGET',
            },
          ]
        : []),
    ]);
    // Invoked inside the existing nonce-guarded acceptance batch. There is no
    // separate public write/commit path and no oversized source text row.
    return (
      commitGuard: string,
      bindings: readonly (string | number | null)[],
    ): Statement[] => {
      const inserts: {
        table: string;
        columns: string[];
        select: string[];
        rows: unknown[];
        prefix: (string | number | null)[];
      }[] = [
        {
          table: 'entities',
          columns: [
            'owner_id',
            'entity_id',
            'label',
            'entity_type',
            'resolution',
            'created_at',
          ],
          select: [
            '?',
            "json_extract(x.value,'$.entity_id')",
            "json_extract(x.value,'$.label')",
            "json_extract(x.value,'$.entity_type')",
            "json_extract(x.value,'$.resolution')",
            '?',
          ],
          rows: entityRows,
          prefix: [this.context.ownerId, now.toISOString()],
        },
        {
          table: 'evidence',
          columns: [
            'owner_id',
            'evidence_id',
            'item_id',
            'source_artifact_id',
            'source_hash',
            'source_start',
            'source_end',
            'quote_hash',
            'segment_ids_json',
            'anchor_snapshot_json',
            'start_ms',
            'end_ms',
            'timestamp_precision',
            'timestamp_url',
            'created_at',
          ],
          select: [
            '?',
            "json_extract(x.value,'$.evidence_id')",
            '?',
            ...[
              'source_artifact_id',
              'source_hash',
              'source_start',
              'source_end',
              'quote_hash',
              'segment_ids_json',
              'anchor_snapshot_json',
              'start_ms',
              'end_ms',
              'timestamp_precision',
              'timestamp_url',
            ].map((key) => `json_extract(x.value,'$.${key}')`),
            '?',
          ],
          rows: evidenceRows,
          prefix: [
            this.context.ownerId,
            value.canonical.item_id,
            now.toISOString(),
          ],
        },
        {
          table: 'analysis_evidence',
          columns: ['owner_id', 'run_id', 'evidence_id'],
          select: ['?', '?', "json_extract(x.value,'$.evidence_id')"],
          rows: evidenceRows,
          prefix: [this.context.ownerId, runId],
        },
        {
          table: 'observations',
          columns: [
            'owner_id',
            'observation_id',
            'run_id',
            'kind',
            'row_json',
            'row_hash',
            'recorded_at',
          ],
          select: [
            '?',
            "json_extract(x.value,'$.observation_id')",
            '?',
            ...['kind', 'row_json', 'row_hash'].map(
              (key) => `json_extract(x.value,'$.${key}')`,
            ),
            '?',
          ],
          rows: observations,
          prefix: [this.context.ownerId, runId, now.toISOString()],
        },
        {
          table: 'observation_evidence',
          columns: ['owner_id', 'observation_id', 'evidence_id'],
          select: [
            '?',
            "json_extract(x.value,'$.observation_id')",
            "json_extract(x.value,'$.evidence_id')",
          ],
          rows: evidenceJoins,
          prefix: [this.context.ownerId],
        },
        {
          table: 'observation_entities',
          columns: ['owner_id', 'observation_id', 'entity_id', 'role'],
          select: [
            '?',
            ...['observation_id', 'entity_id', 'role'].map(
              (key) => `json_extract(x.value,'$.${key}')`,
            ),
          ],
          rows: entityJoins,
          prefix: [this.context.ownerId],
        },
      ];
      return inserts.map((insert) => {
        const json = JSON.stringify(insert.rows);
        if (new TextEncoder().encode(json).length > 65536)
          throw new Error('LEDGER_BATCH_TOO_LARGE');
        return this.db
          .prepare(
            `INSERT INTO ${insert.table}(${insert.columns.join(',')}) SELECT ${insert.select.join(',')} FROM json_each(?) x WHERE ${commitGuard} ON CONFLICT DO NOTHING`,
          )
          .bind(...insert.prefix, json, ...bindings);
      });
    };
  }
}
