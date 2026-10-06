import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { decodeCursor, encodeCursor, pageLimit } from '../db/cursor.js';
import { sha256 } from '../auth/crypto.js';
import { localDayRange } from '../projections/dates.js';

export const observationKinds = [
  'CLAIM',
  'STANCE',
  'USAGE',
  'RECOMMENDATION',
  'PREDICTION',
  'UNCERTAINTY',
  'CONTRADICTION',
] as const;
export interface LedgerFilters {
  entity_id?: string;
  source_id?: string;
  kind?: string;
  date?: string;
  profile_id?: string;
}
export class ObservationLedger {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    context.requireOwner();
  }
  async page(
    filters: LedgerFilters,
    limit: number,
    secret: string,
    now: Date,
    cursorValue?: string,
  ) {
    pageLimit(limit);
    for (const [key, value] of Object.entries(filters)) {
      if (
        !['entity_id', 'source_id', 'kind', 'date', 'profile_id'].includes(
          key,
        ) ||
        typeof value !== 'string' ||
        !value ||
        value.length > 128
      )
        throw new Error('INVALID_LEDGER_FILTER');
    }
    if (filters.kind && !observationKinds.some((kind) => kind === filters.kind))
      throw new Error('INVALID_LEDGER_KIND');
    const range = filters.date ? localDayRange(filters.date) : null;
    const config = Object.keys(filters)
      .sort()
      .map((key) => [key, filters[key as keyof LedgerFilters]]);
    const cursorKind = 'ledger:1:' + (await sha256(JSON.stringify(config)));
    const cursor = cursorValue
      ? await decodeCursor(
          cursorValue,
          this.context.ownerId,
          cursorKind,
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
          `SELECT o.observation_id,o.kind,o.row_json,o.row_hash,o.recorded_at,o.run_id,i.item_id,i.source_id,i.published_at,i.canonical_url,json_extract(m.metadata_json,'$.title') title,COALESCE(c.title,'Źródło') creator,s.selection_revision
        FROM observations o JOIN analysis_runs r ON r.owner_id=o.owner_id AND r.run_id=o.run_id AND r.state='ACCEPTED' AND json_extract(r.outcome_json,'$.version')='intelligence-accepted:1'
        JOIN items i ON i.owner_id=r.owner_id AND i.item_id=r.item_id
        JOIN active_analysis_selections s ON s.owner_id=i.owner_id AND s.item_id=i.item_id AND s.accepted_run_id=r.run_id
        JOIN item_revisions m ON m.owner_id=i.owner_id AND m.item_id=i.item_id AND m.revision_id=i.current_revision_id
        LEFT JOIN channels c ON c.owner_id=i.owner_id AND c.source_id=i.source_id
        WHERE o.owner_id=? AND (? IS NULL OR i.source_id=?) AND (? IS NULL OR o.kind=?)
        AND (? IS NULL OR EXISTS(SELECT 1 FROM observation_entities e WHERE e.owner_id=o.owner_id AND e.observation_id=o.observation_id AND e.entity_id=?))
        AND (? IS NULL OR json_extract(r.profile_snapshot_json,'$.profile_id')=?)
        AND (? IS NULL OR (i.published_at>=? AND i.published_at<?))
        AND (? IS NULL OR o.observation_id>?) ORDER BY o.observation_id LIMIT ?`,
        )
        .bind(
          this.context.ownerId,
          filters.source_id ?? null,
          filters.source_id ?? null,
          filters.kind ?? null,
          filters.kind ?? null,
          filters.entity_id ?? null,
          filters.entity_id ?? null,
          filters.profile_id ?? null,
          filters.profile_id ?? null,
          range?.start ?? null,
          range?.start ?? null,
          range?.end ?? null,
          cursor?.id ?? null,
          cursor?.id ?? null,
          limit + 1,
        ),
    ]);
    const cut = String((result[0]!.results![0] as { cut_seq: number }).cut_seq);
    if (cursor && cursor.snapshot !== cut)
      throw new Error('READ_SNAPSHOT_CHANGED');
    const rows = result[1]!.results! as {
      observation_id: string;
      kind: string;
      row_json: string;
      row_hash: string;
      recorded_at: string;
      run_id: string;
      item_id: string;
      source_id: string;
      published_at: string | null;
      canonical_url: string;
      title: string;
      creator: string;
      selection_revision: number;
    }[];
    const observations = await Promise.all(
      rows.slice(0, limit).map(async ({ row_json, row_hash, ...metadata }) => {
        if ((await sha256(row_json)) !== row_hash)
          throw new Error('LEDGER_INTEGRITY_FAILED');
        const row = JSON.parse(row_json) as Record<string, unknown>;
        if (
          row.observation_id !== metadata.observation_id ||
          row.kind !== metadata.kind
        )
          throw new Error('LEDGER_INTEGRITY_FAILED');
        return { ...metadata, observation: row };
      }),
    );
    return {
      version: 'observation-ledger:1' as const,
      cut_seq: cut,
      sampled_at: cursor?.time ?? now.toISOString(),
      observations,
      next_cursor:
        rows.length > limit
          ? await encodeCursor(
              {
                owner: this.context.ownerId,
                kind: cursorKind,
                snapshot: cut,
                time: cursor?.time ?? now.toISOString(),
                id: observations.at(-1)!.observation_id,
              },
              secret,
            )
          : null,
    };
  }
}
