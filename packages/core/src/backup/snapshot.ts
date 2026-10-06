import type { Database, AccessContext } from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
import ledger from '../../../../db/migration-ledger.json';

export const backupTables = [
  'owner_users',
  'worker_identities',
  'schema_versions',
  'config_versions',
  'audit_events',
  'sources',
  'channels',
  'items',
  'item_revisions',
  'jobs',
  'job_attempts',
  'outbox',
  'artifacts',
  'artifact_chunks',
  'transcript_representations',
  'prompt_versions',
  'model_registry',
  'quota_reservations',
  'usage_records',
  'candidate_repair_attempts',
  'analysis_runs',
  'entities',
  'entity_aliases',
  'entity_alias_decisions',
  'entity_identity_events',
  'entity_identity_members',
  'evidence',
  'analysis_evidence',
  'observations',
  'observation_evidence',
  'observation_entities',
  'correction_overlays',
  'active_analysis_selections',
  'export_state',
  'change_log',
  'source_requests',
  'discovery_scans',
  'discovery_scan_members',
] as const;
export type BackupTable = (typeof backupTables)[number];
type Row = Record<string, string | number | null>;
export interface BackupChunk {
  table: BackupTable;
  cursor: number;
  next_cursor: number | null;
  rows: Row[];
  sha256: string;
  columns: string[];
  index: number;
  bytes: number;
}
export interface BackupManifest {
  version: 1;
  backup_id: string;
  owner_id: string;
  cut_seq: number;
  created_at: string;
  migrations: typeof ledger.migrations;
  tables: Record<
    string,
    { count: number; chunks: Omit<BackupChunk, 'rows' | 'table'>[] }
  >;
  sha256: string;
}
interface Snapshot {
  backup_id: string;
  owner_id: string;
  state: string;
  cut_seq: number;
  created_at: string;
  expires_at: string;
  counts_json: string;
  manifest_json: string | null;
}
function tableSpec(table: BackupTable) {
  if (table === 'owner_users')
    return {
      projection: 'owner_id,issuer,subject,allowlisted,created_at',
      scoped: true,
    };
  if (table === 'worker_identities')
    return {
      projection: 'worker_id,owner_id,scopes_json,created_at,revoked_at',
      scoped: true,
    };
  return { projection: '*', scoped: table !== 'schema_versions' };
}
export function assertSecretFree(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSecretFree(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (
      [
        'authorization',
        'apikey',
        'clientsecret',
        'accesstoken',
        'refreshtoken',
        'password',
        'sessionsigningsecret',
        'workercredential',
        'credentialhash',
        'csrfhash',
        'sessionhash',
      ].includes(key.replaceAll('_', '').toLowerCase())
    )
      throw new Error('BACKUP_SECRET_FIELD');
    if (key.endsWith('_json') && typeof item === 'string')
      assertSecretFree(JSON.parse(item));
    else assertSecretFree(item);
  }
}
export class CoreBackup {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    context.requireOwner();
  }
  private async snapshot(id: string, active = true) {
    const row = await this.db
      .prepare(
        'SELECT * FROM backup_snapshots WHERE owner_id=? AND backup_id=?',
      )
      .bind(this.context.ownerId, id)
      .first<Snapshot>();
    if (!row) throw new Error('NOT_FOUND');
    if (active) {
      const permit = await this.db
        .prepare(
          "SELECT singleton FROM maintenance_state WHERE singleton=1 AND barrier_token=? AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        )
        .bind(id)
        .first();
      if (!permit || row.state !== 'BUILDING')
        throw new Error('BACKUP_EXPIRED_OR_CLOSED');
    }
    return row;
  }
  async begin() {
    const id = crypto.randomUUID(),
      now = new Date(),
      expires = new Date(now.getTime() + 120000).toISOString();
    const acquired = await this.db
      .prepare(
        "UPDATE maintenance_state SET generation=generation+1,barrier_token=?,barrier_until=?,cut_seq=(SELECT COALESCE(MAX(seq),0) FROM change_log) WHERE singleton=1 AND (barrier_token IS NULL OR barrier_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      )
      .bind(id, expires)
      .run();
    if (acquired.meta.changes !== 1) throw new Error('BACKUP_BUSY');
    try {
      const cut = await this.db
        .prepare('SELECT cut_seq FROM maintenance_state WHERE barrier_token=?')
        .bind(id)
        .first<number>('cut_seq');
      const counts: Record<string, number> = {};
      for (const table of backupTables) {
        const scoped = tableSpec(table).scoped;
        const query = this.db.prepare(
          `SELECT COUNT(*) n FROM ${table}${scoped ? ' WHERE owner_id=?' : ''}`,
        );
        counts[table] = (await (
          scoped ? query.bind(this.context.ownerId) : query
        ).first<number>('n'))!;
      }
      await this.db
        .prepare(
          "INSERT INTO backup_snapshots(backup_id,owner_id,state,cut_seq,created_at,expires_at,counts_json) VALUES(?,?,'BUILDING',?,?,?,?)",
        )
        .bind(
          id,
          this.context.ownerId,
          cut!,
          now.toISOString(),
          expires,
          JSON.stringify(counts),
        )
        .run();
      await this.snapshot(id);
      return {
        backup_id: id,
        state: 'BUILDING',
        expires_at: expires,
        cut_seq: cut,
        tables: backupTables,
      };
    } catch (error) {
      await this.db
        .prepare(
          'UPDATE maintenance_state SET barrier_token=NULL,barrier_until=NULL WHERE barrier_token=?',
        )
        .bind(id)
        .run();
      throw error;
    }
  }
  async chunk(
    id: string,
    table: BackupTable,
    cursor: number,
  ): Promise<BackupChunk> {
    if (
      !backupTables.includes(table) ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0
    )
      throw new Error('INVALID_BACKUP_CURSOR');
    const snapshot = await this.snapshot(id),
      counts = JSON.parse(snapshot.counts_json) as Record<string, number>;
    const spec = tableSpec(table);
    const query = this.db.prepare(
      `SELECT rowid AS __cursor,${spec.projection} FROM ${table} WHERE rowid>?${spec.scoped ? ' AND owner_id=?' : ''} ORDER BY rowid LIMIT 25`,
    );
    const raw = (
      await query
        .bind(cursor, ...(spec.scoped ? [this.context.ownerId] : []))
        .all<Row>()
    ).results;
    // Limit each hash/serialization work unit, independently of total corpus size.
    const rows: Row[] = [],
      rowCursors: number[] = [];
    let bytes = 2;
    for (const row of raw) {
      const { __cursor, ...data } = row;
      if (table === 'owner_users') {
        data.subject_hash = await sha256(String(data.subject));
        delete data.subject;
      }
      assertSecretFree(data);
      const size =
        new TextEncoder().encode(JSON.stringify(data)).byteLength + 1;
      if (rows.length && bytes + size > 64000) break;
      if (size > 64000) throw new Error('BACKUP_ROW_TOO_LARGE');
      bytes += size;
      rows.push(data);
      rowCursors.push(Number(__cursor));
    }
    const previous = (
      await this.db
        .prepare(
          'SELECT cursor,next_cursor,chunk_index,count FROM backup_chunks WHERE owner_id=? AND backup_id=? AND table_name=? ORDER BY chunk_index',
        )
        .bind(this.context.ownerId, id, table)
        .all<{
          cursor: number;
          next_cursor: number | null;
          chunk_index: number;
          count: number;
        }>()
    ).results;
    const existing = previous.find((row) => row.cursor === cursor);
    const last = previous.at(-1);
    if (
      !existing &&
      (cursor === 0 ? previous.length !== 0 : last?.next_cursor !== cursor)
    )
      throw new Error('INVALID_BACKUP_CURSOR');
    const before = previous
      .filter(
        (row) => row.chunk_index < (existing?.chunk_index ?? previous.length),
      )
      .reduce((sum, row) => sum + row.count, 0);
    const next =
      before + rows.length === counts[table]
        ? null
        : (rowCursors.at(-1) ?? null);
    if (next === null && before + rows.length !== counts[table])
      throw new Error('BACKUP_COUNT_MISMATCH');
    let columns = rows[0]
      ? Object.keys(rows[0])
      : (
          await this.db
            .prepare(`PRAGMA table_info(${table})`)
            .all<{ name: string }>()
        ).results.map((row) => row.name);
    if (table === 'owner_users')
      columns = columns.filter((column) => column !== 'subject');
    if (table === 'owner_users' && !columns.includes('subject_hash'))
      columns.push('subject_hash');
    if (table === 'worker_identities')
      columns = columns.filter((column) => column !== 'credential_hash');
    bytes = new TextEncoder().encode(JSON.stringify(rows)).byteLength;
    const result: BackupChunk = {
      table,
      cursor,
      next_cursor: next,
      rows,
      sha256: await sha256(JSON.stringify(rows)),
      columns,
      index: existing?.chunk_index ?? previous.length,
      bytes,
    };
    await this.snapshot(id); // Expiry during an awaited read never becomes a valid cut.
    await this.db
      .prepare(
        'INSERT INTO backup_chunks(owner_id,backup_id,table_name,chunk_index,cursor,next_cursor,count,sha256,columns_json,bytes) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,backup_id,table_name,cursor) DO NOTHING',
      )
      .bind(
        this.context.ownerId,
        id,
        table,
        result.index,
        cursor,
        next,
        rows.length,
        result.sha256,
        JSON.stringify(columns),
        bytes,
      )
      .run();
    const saved = await this.db
      .prepare(
        'SELECT sha256 FROM backup_chunks WHERE owner_id=? AND backup_id=? AND table_name=? AND cursor=?',
      )
      .bind(this.context.ownerId, id, table, cursor)
      .first<string>('sha256');
    if (saved !== result.sha256) throw new Error('BACKUP_CHUNK_MISMATCH');
    return result;
  }
  async complete(id: string): Promise<BackupManifest> {
    const snapshot = await this.snapshot(id),
      counts = JSON.parse(snapshot.counts_json) as Record<string, number>;
    const receipts = (
      await this.db
        .prepare(
          'SELECT * FROM backup_chunks WHERE owner_id=? AND backup_id=? ORDER BY table_name,chunk_index',
        )
        .bind(this.context.ownerId, id)
        .all<{
          table_name: string;
          chunk_index: number;
          cursor: number;
          next_cursor: number | null;
          count: number;
          sha256: string;
          columns_json: string;
          bytes: number;
        }>()
    ).results;
    const tables: BackupManifest['tables'] = {};
    let bytes = 0;
    for (const table of backupTables) {
      const chunks = receipts.filter((row) => row.table_name === table);
      let cursor: number | null = 0,
        count = 0;
      for (let index = 0; index < chunks.length; index++) {
        const row = chunks[index]!;
        if (
          cursor === null ||
          row.cursor !== cursor ||
          row.chunk_index !== index
        )
          throw new Error('BACKUP_CHAIN_MISMATCH');
        cursor = row.next_cursor;
        count += row.count;
        bytes += row.bytes;
      }
      if (!chunks.length || cursor !== null || count !== counts[table])
        throw new Error('BACKUP_INCOMPLETE');
      tables[table] = {
        count,
        chunks: chunks.map((row) => ({
          cursor: row.cursor,
          next_cursor: row.next_cursor,
          sha256: row.sha256,
          columns: JSON.parse(row.columns_json),
          index: row.chunk_index,
          bytes: row.bytes,
        })),
      };
    }
    if (bytes > 2 * 1024 * 1024 || receipts.length > 200)
      throw new Error('BACKUP_PILOT_LIMIT');
    const body = {
      version: 1 as const,
      backup_id: id,
      owner_id: this.context.ownerId,
      cut_seq: snapshot.cut_seq,
      created_at: snapshot.created_at,
      migrations: ledger.migrations,
      tables,
    };
    const manifest = { ...body, sha256: await sha256(JSON.stringify(body)) };
    const results = await this.db.batch([
      this.db
        .prepare(
          "UPDATE backup_snapshots SET state='VERIFIED',manifest_json=?,manifest_hash=? WHERE owner_id=? AND backup_id=? AND state='BUILDING' AND EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token=? AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        )
        .bind(
          JSON.stringify(manifest),
          manifest.sha256,
          this.context.ownerId,
          id,
          id,
        ),
      this.db
        .prepare(
          "UPDATE maintenance_state SET barrier_token=NULL,barrier_until=NULL WHERE barrier_token=? AND EXISTS(SELECT 1 FROM backup_snapshots WHERE owner_id=? AND backup_id=? AND state='VERIFIED')",
        )
        .bind(id, this.context.ownerId, id),
    ]);
    if (results[0]?.meta.changes !== 1)
      throw new Error('BACKUP_EXPIRED_OR_CLOSED');
    return manifest;
  }
  async manifest(id: string) {
    const row = await this.snapshot(id, false);
    if (row.state !== 'VERIFIED' || !row.manifest_json)
      throw new Error('BACKUP_NOT_VERIFIED');
    return JSON.parse(row.manifest_json) as BackupManifest;
  }
  async abort(id: string) {
    await this.snapshot(id, false);
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE backup_snapshots SET state='FAILED',error_code='ABORTED' WHERE owner_id=? AND backup_id=? AND state='BUILDING'",
        )
        .bind(this.context.ownerId, id),
      this.db
        .prepare(
          'UPDATE maintenance_state SET barrier_token=NULL,barrier_until=NULL WHERE barrier_token=?',
        )
        .bind(id),
    ]);
  }
}
