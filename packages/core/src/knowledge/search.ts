import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { decodeCursor, encodeCursor, pageLimit } from '../db/cursor.js';
import { sha256 } from '../auth/crypto.js';
import { literalSearchQuery } from './search-query.js';
import { SearchIndex } from './search-index.js';
import { effectiveEntity } from './identity.js';
export interface SearchFilters {
  kind?: string;
  source_id?: string;
  space_id?: string;
  entity_id?: string;
}
const kinds = [
  'ITEM',
  'OBSERVATION',
  'INSIGHT',
  'ENTITY',
  'ALIAS',
  'SUMMARY_PREVIEW',
];
export class KnowledgeSearch {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    context.requireOwner();
  }
  async page(
    query: string,
    filters: SearchFilters,
    limit: number,
    secret: string,
    now: Date,
    cursorValue?: string,
  ) {
    pageLimit(limit);
    const match = literalSearchQuery(query);
    for (const [key, value] of Object.entries(filters))
      if (
        !['kind', 'source_id', 'space_id', 'entity_id'].includes(key) ||
        typeof value !== 'string' ||
        !value ||
        value.length > 128
      )
        throw new Error('INVALID_SEARCH_FILTER');
    if (filters.kind && !kinds.includes(filters.kind))
      throw new Error('INVALID_SEARCH_FILTER');
    const kind =
      'search:' +
      (await sha256(
        JSON.stringify({
          match,
          filters: Object.fromEntries(
            Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)),
          ),
        }),
      ));
    const cursor = cursorValue
      ? await decodeCursor(cursorValue, this.context.ownerId, kind, secret)
      : null;
    if (cursor && !/^[1-9][0-9]{0,15}$/.test(cursor.id))
      throw new Error('INVALID_CURSOR');
    const metadata = await new SearchIndex(this.db, this.context).metadata();
    const snapshot = await sha256(JSON.stringify(metadata));
    if (cursor && cursor.snapshot !== snapshot)
      throw new Error('READ_SNAPSHOT_CHANGED');
    const result = await this.db
      .prepare(
        `SELECT knowledge_fts.rowid doc_rowid,d.doc_id,d.parent_id,d.item_id,d.run_id,d.kind,d.observation_id,d.entity_id,substr(d.text,1,1000) text,i.published_at,json_extract(m.metadata_json,'$.title') title
   FROM knowledge_fts JOIN search_documents d ON d.rowid=knowledge_fts.rowid
   LEFT JOIN items i ON i.owner_id=d.owner_id AND i.item_id=d.item_id LEFT JOIN item_revisions m ON m.owner_id=i.owner_id AND m.item_id=i.item_id AND m.revision_id=i.current_revision_id
   WHERE knowledge_fts MATCH ? AND d.owner_id=? AND (CASE d.kind WHEN 'ITEM' THEN EXISTS(SELECT 1 FROM search_item_documents s WHERE s.owner_id=d.owner_id AND s.doc_id=d.parent_id) WHEN 'OBSERVATION' THEN EXISTS(SELECT 1 FROM search_observation_documents s WHERE s.owner_id=d.owner_id AND s.doc_id=d.parent_id) WHEN 'INSIGHT' THEN EXISTS(SELECT 1 FROM search_insight_documents s WHERE s.owner_id=d.owner_id AND s.doc_id=d.parent_id) WHEN 'ENTITY' THEN EXISTS(SELECT 1 FROM search_entity_documents s WHERE s.owner_id=d.owner_id AND s.doc_id=d.parent_id) WHEN 'ALIAS' THEN EXISTS(SELECT 1 FROM search_alias_documents s WHERE s.owner_id=d.owner_id AND s.doc_id=d.parent_id) WHEN 'SUMMARY_PREVIEW' THEN EXISTS(SELECT 1 FROM search_summary_documents s WHERE s.owner_id=d.owner_id AND s.doc_id=d.parent_id) ELSE 0 END) AND (? IS NULL OR d.kind=?) AND (? IS NULL OR i.source_id=?)
   AND (? IS NULL OR EXISTS(SELECT 1 FROM item_spaces x JOIN spaces p ON p.owner_id=x.owner_id AND p.space_id=x.space_id AND p.active=1 WHERE x.owner_id=d.owner_id AND x.item_id=d.item_id AND x.space_id=? AND x.active=1))
   AND (? IS NULL OR EXISTS(SELECT 1 FROM entities e WHERE e.owner_id=d.owner_id AND e.entity_id=d.entity_id AND ${effectiveEntity('e')}=(SELECT ${effectiveEntity('t')} FROM entities t WHERE t.owner_id=d.owner_id AND t.entity_id=?)) OR EXISTS(SELECT 1 FROM observation_entities e WHERE e.owner_id=d.owner_id AND e.observation_id=d.observation_id AND ${effectiveEntity('e')}=(SELECT ${effectiveEntity('t')} FROM entities t WHERE t.owner_id=d.owner_id AND t.entity_id=?)))
   AND knowledge_fts.rowid>? ORDER BY knowledge_fts.rowid LIMIT ?`,
      )
      .bind(
        match,
        this.context.ownerId,
        filters.kind ?? null,
        filters.kind ?? null,
        filters.source_id ?? null,
        filters.source_id ?? null,
        filters.space_id ?? null,
        filters.space_id ?? null,
        filters.entity_id ?? null,
        filters.entity_id ?? null,
        filters.entity_id ?? null,
        cursor ? Number(cursor.id) : 0,
        limit + 1,
      )
      .all<{
        doc_rowid: number;
        doc_id: string;
        parent_id: string;
        item_id: string | null;
        run_id: string | null;
        kind: string;
        observation_id: string | null;
        entity_id: string | null;
        text: string;
        published_at: string | null;
        title: string | null;
      }>();
    const after = await new SearchIndex(this.db, this.context).metadata();
    if ((await sha256(JSON.stringify(after))) !== snapshot)
      throw new Error('READ_SNAPSHOT_CHANGED');
    const rows = result.results.slice(0, limit);
    return {
      documents: rows,
      freshness: metadata.freshness,
      indexed_cut: metadata.state?.indexed_cut ?? null,
      current_cut: metadata.cut_seq,
      scope:
        'TITLE_TYPED_KNOWLEDGE_MANUAL_NOTES_ENTITIES_ALIASES_ANALYSIS_PREVIEW' as const,
      next_cursor:
        result.results.length > limit
          ? await encodeCursor(
              {
                owner: this.context.ownerId,
                kind,
                snapshot,
                time: now.toISOString(),
                id: String(rows.at(-1)!.doc_rowid),
              },
              secret,
            )
          : null,
    };
  }
}
