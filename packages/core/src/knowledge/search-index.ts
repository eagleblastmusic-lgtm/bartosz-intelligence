import {
  assertContext,
  type AccessContext,
  type Database,
  type Statement,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
import { foldSearchText } from './search-query.js';
interface State {
  generation: string;
  indexed_cut: number;
  target_cut: number;
  phase: 'BUILDING' | 'CLEANUP' | 'COMPLETE';
  cursor: string;
  updated_at: string;
}
interface Progress {
  after: string;
  part: { id: string; offset: number; hash: string } | null;
}
export interface SearchSourceDocument {
  doc_id: string;
  item_id: string | null;
  run_id: string | null;
  kind: string;
  observation_id: string | null;
  entity_id: string | null;
  text: string;
}
export class SearchIndex {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    if (context.kind === 'owner') context.requireOwner();
    else context.requireTask('PROJECT');
  }
  private guard() {
    return this.context.kind === 'owner'
      ? { sql: '1', bindings: [] as (string | number | null)[] }
      : {
          sql: 'EXISTS(SELECT 1 FROM worker_identities WHERE owner_id=? AND worker_id=? AND credential_hash=? AND revoked_at IS NULL)',
          bindings: [
            this.context.ownerId,
            this.context.actorId,
            this.context.credentialHash!,
          ],
        };
  }
  async metadata() {
    const result = await this.db.batch([
      this.db
        .prepare(
          'SELECT generation,indexed_cut,target_cut,phase,cursor,updated_at FROM search_index_state WHERE owner_id=?',
        )
        .bind(this.context.ownerId),
      this.db
        .prepare(
          'SELECT COALESCE(MAX(seq),0) cut_seq FROM change_log WHERE owner_id=?',
        )
        .bind(this.context.ownerId),
    ]);
    const state = result[0]!.results![0] as State | undefined,
      cut = (result[1]!.results![0] as { cut_seq: number }).cut_seq;
    return {
      state: state ?? null,
      cut_seq: cut,
      freshness: !state
        ? 'UNKNOWN'
        : state.phase !== 'COMPLETE'
          ? 'BUILDING'
          : state.indexed_cut === cut
            ? 'FRESH'
            : 'STALE',
    } as const;
  }
  async step(now: Date) {
    const { state, cut_seq } = await this.metadata(),
      auth = this.guard();
    if (!state) {
      const result = await this.db
        .prepare(
          `INSERT INTO search_index_state SELECT ?,?,0,?,'BUILDING',?,? WHERE ${auth.sql} ON CONFLICT(owner_id) DO NOTHING RETURNING generation`,
        )
        .bind(
          this.context.ownerId,
          crypto.randomUUID(),
          cut_seq,
          JSON.stringify({ after: '', part: null }),
          now.toISOString(),
          ...auth.bindings,
        )
        .all();
      return { progressed: !!result.results.length, phase: 'BUILDING' };
    }
    if (state.phase === 'COMPLETE') {
      const changes = (
        await this.db
          .prepare(
            'SELECT seq,component FROM change_log WHERE owner_id=? AND seq>? ORDER BY seq LIMIT 50',
          )
          .bind(this.context.ownerId, state.indexed_cut)
          .all<{ seq: number; component: string }>()
      ).results;
      if (!changes.length) return { progressed: false, phase: 'COMPLETE' };
      const relevant = changes.some(
        (row) => !['jobs', 'discovery'].includes(row.component),
      );
      const result = await this.db
        .prepare(
          `UPDATE search_index_state SET generation=?,target_cut=?,phase=?,cursor=?,indexed_cut=?,updated_at=? WHERE owner_id=? AND generation=? AND indexed_cut=? AND phase='COMPLETE' AND ${auth.sql} RETURNING generation`,
        )
        .bind(
          relevant ? crypto.randomUUID() : state.generation,
          relevant ? cut_seq : state.target_cut,
          relevant ? 'BUILDING' : 'COMPLETE',
          relevant ? JSON.stringify({ after: '', part: null }) : state.cursor,
          relevant ? state.indexed_cut : changes.at(-1)!.seq,
          now.toISOString(),
          this.context.ownerId,
          state.generation,
          state.indexed_cut,
          ...auth.bindings,
        )
        .all();
      return {
        progressed: !!result.results.length,
        phase: relevant ? 'BUILDING' : 'COMPLETE',
      };
    }
    const guard = `EXISTS(SELECT 1 FROM search_index_state WHERE owner_id=? AND generation=? AND phase=? AND cursor=?) AND ${auth.sql}`;
    const bindings = [
      this.context.ownerId,
      state.generation,
      state.phase,
      state.cursor,
      ...auth.bindings,
    ];
    if (state.phase === 'CLEANUP') {
      const rows = (
        await this.db
          .prepare(
            'SELECT doc_id FROM search_documents WHERE owner_id=? AND generation<>? AND doc_id>? ORDER BY doc_id LIMIT 50',
          )
          .bind(this.context.ownerId, state.generation, state.cursor)
          .all<{ doc_id: string }>()
      ).results;
      const effects = rows.map((row) =>
        this.db
          .prepare(
            `DELETE FROM search_documents WHERE owner_id=? AND doc_id=? AND ${guard}`,
          )
          .bind(this.context.ownerId, row.doc_id, ...bindings),
      );
      const complete = rows.length < 50;
      const result = await this.db.batch([
        ...effects,
        this.db
          .prepare(
            `UPDATE search_index_state SET phase=?,cursor=?,indexed_cut=?,updated_at=? WHERE ${guard} RETURNING phase`,
          )
          .bind(
            complete ? 'COMPLETE' : 'CLEANUP',
            complete ? '' : rows.at(-1)!.doc_id,
            complete ? state.target_cut : state.indexed_cut,
            now.toISOString(),
            ...bindings,
          ),
      ]);
      return {
        progressed: !!result.at(-1)!.results!.length,
        phase: complete ? 'COMPLETE' : 'CLEANUP',
      };
    }
    const progress = JSON.parse(state.cursor) as Progress;
    // Document prefixes define disjoint ordered ranges. Exhaust one range
    // before reading the next: no repeated scans of future JSON summaries.
    const ranges = [
      ['ALIAS', 'alias'],
      ['ENTITY', 'entity'],
      ['INSIGHT', 'insight'],
      ['ITEM', 'item'],
      ['OBSERVATION', 'observation'],
      ['SUMMARY_PREVIEW', 'summary'],
    ] as const;
    const afterKind = (progress.part?.id ?? progress.after).split(':')[0]!;
    if (afterKind && !ranges.some(([prefix]) => prefix === afterKind))
      throw new Error('INVALID_SEARCH_INDEX_CURSOR');
    let source: SearchSourceDocument | null = null;
    for (const [prefix, kind] of ranges) {
      if (prefix < afterKind || (progress.part && prefix !== afterKind))
        continue;
      source = await this.db
        .prepare(
          `SELECT doc_id,item_id,run_id,kind,observation_id,entity_id,text FROM search_${kind}_documents WHERE owner_id=? AND ${progress.part ? 'doc_id=?' : 'doc_id>?'} ORDER BY doc_id LIMIT 1`,
        )
        .bind(this.context.ownerId, progress.part?.id ?? progress.after)
        .first<SearchSourceDocument>();
      if (source) break;
    }
    if (!source) {
      const next = progress.part
        ? { after: progress.part.id, part: null }
        : null;
      const result = await this.db
        .prepare(
          `UPDATE search_index_state SET phase=?,cursor=?,updated_at=? WHERE ${guard} RETURNING phase`,
        )
        .bind(
          next ? 'BUILDING' : 'CLEANUP',
          next ? JSON.stringify(next) : '',
          now.toISOString(),
          ...bindings,
        )
        .all();
      return {
        progressed: !!result.results.length,
        phase: next ? 'BUILDING' : 'CLEANUP',
      };
    }
    if (source.kind === 'OBSERVATION') {
      const original = await this.db
        .prepare(
          'SELECT row_json,row_hash FROM observations WHERE owner_id=? AND observation_id=?',
        )
        .bind(this.context.ownerId, source.observation_id)
        .first<{ row_json: string; row_hash: string }>();
      if (!original || (await sha256(original.row_json)) !== original.row_hash)
        throw new Error('LEDGER_INTEGRITY_FAILED');
      const row = JSON.parse(original.row_json) as Record<string, unknown>;
      if (row.observation_id !== source.observation_id)
        throw new Error('LEDGER_INTEGRITY_FAILED');
    }
    const hash = await sha256(source.text);
    if (progress.part && progress.part.hash !== hash) {
      const result = await this.db
        .prepare(
          `UPDATE search_index_state SET generation=?,target_cut=?,cursor=?,updated_at=? WHERE ${guard} RETURNING generation`,
        )
        .bind(
          crypto.randomUUID(),
          cut_seq,
          JSON.stringify({ after: '', part: null }),
          now.toISOString(),
          ...bindings,
        )
        .all();
      return { progressed: !!result.results.length, phase: 'BUILDING' };
    }
    let offset = progress.part?.offset ?? 0;
    const effects: Statement[] = [];
    for (let count = 0; count < 4 && offset < source.text.length; count++) {
      let end = Math.min(source.text.length, offset + 8192);
      if (
        end < source.text.length &&
        /[\uD800-\uDBFF]/.test(source.text[end - 1]!) &&
        /[\uDC00-\uDFFF]/.test(source.text[end]!)
      )
        end--;
      const text = source.text.slice(offset, end),
        docId = source.doc_id + '#' + String(offset).padStart(10, '0');
      effects.push(
        this.db
          .prepare(
            `INSERT INTO search_documents SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(owner_id,doc_id) DO UPDATE SET parent_id=excluded.parent_id,item_id=excluded.item_id,run_id=excluded.run_id,kind=excluded.kind,observation_id=excluded.observation_id,entity_id=excluded.entity_id,text=excluded.text,search_text=excluded.search_text,content_hash=excluded.content_hash,generation=excluded.generation`,
          )
          .bind(
            this.context.ownerId,
            docId,
            source.doc_id,
            source.item_id,
            source.run_id,
            source.kind,
            source.observation_id,
            source.entity_id,
            text,
            foldSearchText(text),
            await sha256(text),
            state.generation,
            ...bindings,
          ),
      );
      if (end === source.text.length) {
        offset = end;
        break;
      }
      offset = end - 256;
      if (
        /[\uDC00-\uDFFF]/.test(source.text[offset]!) &&
        /[\uD800-\uDBFF]/.test(source.text[offset - 1]!)
      )
        offset--;
    }
    const next: Progress =
      offset >= source.text.length
        ? { after: source.doc_id, part: null }
        : { after: progress.after, part: { id: source.doc_id, offset, hash } };
    const result = await this.db.batch([
      ...effects,
      this.db
        .prepare(
          `UPDATE search_index_state SET cursor=?,updated_at=? WHERE ${guard} RETURNING cursor`,
        )
        .bind(JSON.stringify(next), now.toISOString(), ...bindings),
    ]);
    return { progressed: !!result.at(-1)!.results!.length, phase: 'BUILDING' };
  }
  async rebuild(now: Date) {
    this.context.requireOwner();
    const { cut_seq } = await this.metadata();
    await this.db
      .prepare(
        `INSERT INTO search_index_state VALUES(?,?,0,?,'BUILDING',?,?) ON CONFLICT(owner_id) DO UPDATE SET generation=excluded.generation,target_cut=excluded.target_cut,phase='BUILDING',cursor=excluded.cursor,updated_at=excluded.updated_at`,
      )
      .bind(
        this.context.ownerId,
        crypto.randomUUID(),
        cut_seq,
        JSON.stringify({ after: '', part: null }),
        now.toISOString(),
      )
      .run();
    return this.metadata();
  }
}
