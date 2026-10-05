import type { AccessContext, Database } from '../db/boundary.js';
import { assertContext } from '../db/boundary.js';
import type { LeaseToken, TaskType } from '../../../contracts/src/jobs.js';
import { leasePredicate } from '../jobs/lease-guard.js';
import { base64url, decode64, sha256 } from '../auth/crypto.js';
import { sha256 as incrementalSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
export const artifactChunkBytes = 32768;
export type ArtifactKind =
  | 'RAW'
  | 'SOURCE_ORIGINAL'
  | 'NORMALIZED'
  | 'PL_HELPER'
  | 'ANALYSIS_CANDIDATE'
  | 'SEGMENT_MAP'
  | 'OFFSET_MAP';
export interface ArtifactDescriptor {
  item_id: string;
  kind: ArtifactKind;
  content_hash: string;
  byte_size: number;
  chunk_count: number;
  schema_version: string;
  producer_version: string;
  provenance: Record<string, unknown>;
  original_ref: string | null;
}
export interface ArtifactRow extends Omit<ArtifactDescriptor, 'provenance'> {
  artifact_id: string;
  owner_id: string;
  state: 'UPLOADING' | 'VERIFIED';
  manifest_hash: string | null;
  provenance_json: string;
  created_at: string;
  verified_at: string | null;
}
export interface ArtifactChunk {
  owner_id: string;
  item_id: string;
  artifact_id: string;
  chunk_index: number;
  byte_start: number;
  byte_size: number;
  byte_hash: string;
  storage_ref: string;
  body_base64: string;
}
const hashBytes = (bytes: Uint8Array) => bytesToHex(incrementalSha256(bytes));
export function splitArtifactText(text: string): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let parts: string[] = [],
    size = 0;
  for (const point of text) {
    const length = new TextEncoder().encode(point).byteLength;
    if (size + length > artifactChunkBytes) {
      chunks.push(new TextEncoder().encode(parts.join('')));
      parts = [];
      size = 0;
    }
    parts.push(point);
    size += length;
  }
  if (parts.length || !chunks.length)
    chunks.push(new TextEncoder().encode(parts.join('')));
  return chunks;
}
export class ArtifactRepository {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  private guard(token: LeaseToken, task: TaskType, now: Date) {
    return leasePredicate(this.context, token, now.toISOString(), task);
  }
  async begin(
    descriptor: ArtifactDescriptor,
    token: LeaseToken,
    task: TaskType,
    now: Date,
  ) {
    if (
      !/^[a-f0-9]{64}$/.test(descriptor.content_hash) ||
      !Number.isSafeInteger(descriptor.byte_size) ||
      descriptor.byte_size < 0 ||
      !Number.isSafeInteger(descriptor.chunk_count) ||
      descriptor.chunk_count < 1 ||
      descriptor.chunk_count > 1024 ||
      descriptor.byte_size > descriptor.chunk_count * artifactChunkBytes ||
      !descriptor.producer_version ||
      !descriptor.schema_version
    )
      throw new Error('INVALID_ARTIFACT');
    const provenance = JSON.stringify(descriptor.provenance);
    if (new TextEncoder().encode(provenance).byteLength > 8000)
      throw new Error('INVALID_ARTIFACT');
    const guard = this.guard(token, task, now),
      id = crypto.randomUUID();
    if (descriptor.original_ref !== null) {
      const original = await this.get(
        descriptor.original_ref,
        token,
        task,
        now,
      );
      if (
        original.item_id !== descriptor.item_id ||
        original.state !== 'VERIFIED'
      )
        throw new Error('ARTIFACT_PARENT_NOT_VERIFIED');
    }
    await this.db
      .prepare(
        `INSERT INTO artifacts(artifact_id,owner_id,item_id,kind,content_hash,byte_size,chunk_count,schema_version,producer_version,provenance_json,original_ref,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.predicate} AND EXISTS(SELECT 1 FROM jobs WHERE owner_id=? AND job_id=? AND item_id=?)
      ON CONFLICT(owner_id,item_id,kind,content_hash,producer_version) DO NOTHING`,
      )
      .bind(
        id,
        this.context.ownerId,
        descriptor.item_id,
        descriptor.kind,
        descriptor.content_hash,
        descriptor.byte_size,
        descriptor.chunk_count,
        descriptor.schema_version,
        descriptor.producer_version,
        provenance,
        descriptor.original_ref,
        now.toISOString(),
        ...guard.bindings,
        this.context.ownerId,
        token.job_id,
        descriptor.item_id,
      )
      .run();
    const result = await this.db
      .prepare(
        `SELECT * FROM artifacts WHERE owner_id=? AND item_id=? AND kind=? AND content_hash=? AND producer_version=? AND ${guard.predicate}`,
      )
      .bind(
        this.context.ownerId,
        descriptor.item_id,
        descriptor.kind,
        descriptor.content_hash,
        descriptor.producer_version,
        ...guard.bindings,
      )
      .first<ArtifactRow>();
    if (!result) throw new Error('STALE_FENCE');
    if (
      result.byte_size !== descriptor.byte_size ||
      result.chunk_count !== descriptor.chunk_count ||
      result.schema_version !== descriptor.schema_version ||
      result.provenance_json !== provenance ||
      result.original_ref !== descriptor.original_ref
    )
      throw new Error('ARTIFACT_DESCRIPTOR_CONFLICT');
    return result;
  }
  async get(id: string, token?: LeaseToken, task?: TaskType, now = new Date()) {
    let filter = '',
      bindings: readonly (string | number | null)[] = [];
    if (this.context.kind === 'worker') {
      if (!token || !task) throw new Error('FORBIDDEN');
      const guard = this.guard(token, task, now);
      filter = ` AND ${guard.predicate} AND EXISTS(SELECT 1 FROM jobs WHERE owner_id=? AND job_id=? AND item_id=artifacts.item_id)`;
      bindings = [...guard.bindings, this.context.ownerId, token.job_id];
    }
    const result = await this.db
      .prepare(
        `SELECT * FROM artifacts WHERE owner_id=? AND artifact_id=?${filter}`,
      )
      .bind(this.context.ownerId, id, ...bindings)
      .first<ArtifactRow>();
    if (!result) throw new Error('NOT_FOUND');
    return result;
  }
  async writeChunk(
    id: string,
    index: number,
    start: number,
    bytes: Uint8Array,
    token: LeaseToken,
    task: TaskType,
    now: Date,
  ) {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      bytes.byteLength > artifactChunkBytes
    )
      throw new Error('INVALID_ARTIFACT_CHUNK');
    const header = await this.get(id, token, task, now);
    if (
      index >= header.chunk_count ||
      start + bytes.byteLength > header.byte_size
    )
      throw new Error('INVALID_ARTIFACT_CHUNK');
    const hash = hashBytes(bytes),
      body = bytes.length ? base64url(bytes) : '',
      guard = this.guard(token, task, now);
    await this.db
      .prepare(
        `INSERT INTO artifact_chunks(owner_id,item_id,artifact_id,chunk_index,byte_start,byte_size,byte_hash,storage_ref,body_base64)
      SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM artifacts WHERE owner_id=? AND artifact_id=? AND state='UPLOADING') AND ${guard.predicate}
      ON CONFLICT(owner_id,artifact_id,chunk_index) DO NOTHING`,
      )
      .bind(
        this.context.ownerId,
        header.item_id,
        id,
        index,
        start,
        bytes.length,
        hash,
        `d1:${id}/${index}`,
        body,
        this.context.ownerId,
        id,
        ...guard.bindings,
      )
      .run();
    const saved = await this.chunk(id, index, token, task, now);
    if (
      saved.byte_hash !== hash ||
      saved.byte_start !== start ||
      saved.byte_size !== bytes.length
    )
      throw new Error('ARTIFACT_CHUNK_CONFLICT');
    return { index, byte_hash: hash, byte_size: bytes.length };
  }
  async chunk(
    id: string,
    index: number,
    token?: LeaseToken,
    task?: TaskType,
    now = new Date(),
  ) {
    const header = await this.get(id, token, task, now);
    const row = await this.db
      .prepare(
        'SELECT * FROM artifact_chunks WHERE owner_id=? AND artifact_id=? AND chunk_index=?',
      )
      .bind(this.context.ownerId, header.artifact_id, index)
      .first<ArtifactChunk>();
    if (!row) throw new Error('ARTIFACT_CHUNK_MISSING');
    const bytes = row.body_base64
      ? decode64(row.body_base64)
      : new Uint8Array();
    if (
      bytes.length !== row.byte_size ||
      hashBytes(bytes) !== row.byte_hash ||
      row.storage_ref !== `d1:${id}/${index}`
    )
      throw new Error('ARTIFACT_CHUNK_CORRUPT');
    return row;
  }
  // Local executor orchestration only. A large source must not run this loop in
  // one Workers Free request; its per-chunk reads/writes are bounded RPC units.
  async verifyLocal(
    id: string,
    token: LeaseToken,
    task: TaskType,
    now: Date,
    runtime: 'local',
    clock?: () => Date,
  ) {
    if (runtime !== 'local') throw new Error('LOCAL_VERIFICATION_REQUIRED');
    const startedAt = Date.now();
    const currentTime =
      clock ?? (() => new Date(now.getTime() + Date.now() - startedAt));
    const header = await this.get(id, token, task, currentTime()),
      content = incrementalSha256.create(),
      manifest = incrementalSha256.create();
    let offset = 0;
    for (let index = 0; index < header.chunk_count; index++) {
      const chunk = await this.chunk(id, index, token, task, currentTime());
      if (chunk.byte_start !== offset)
        throw new Error('ARTIFACT_RANGE_MISMATCH');
      content.update(
        chunk.body_base64 ? decode64(chunk.body_base64) : new Uint8Array(),
      );
      manifest.update(
        new TextEncoder().encode(
          JSON.stringify({
            index,
            start: offset,
            bytes: chunk.byte_size,
            hash: chunk.byte_hash,
          }) + '\n',
        ),
      );
      offset += chunk.byte_size;
    }
    if (
      offset !== header.byte_size ||
      bytesToHex(content.digest()) !== header.content_hash
    )
      throw new Error('ARTIFACT_CONTENT_MISMATCH');
    const manifestHash = await sha256(
      JSON.stringify({
        version: 1,
        item_id: header.item_id,
        kind: header.kind,
        content_hash: header.content_hash,
        byte_size: offset,
        chunk_count: header.chunk_count,
        chunk_manifest_hash: bytesToHex(manifest.digest()),
        schema_version: header.schema_version,
        producer_version: header.producer_version,
        provenance: JSON.parse(header.provenance_json),
        original_ref: header.original_ref,
      }),
    );
    if (header.state === 'VERIFIED') {
      if (header.manifest_hash !== manifestHash)
        throw new Error('ARTIFACT_MANIFEST_MISMATCH');
      return this.get(id, token, task, currentTime());
    }
    const commitAt = currentTime();
    const guard = this.guard(token, task, commitAt);
    const result = await this.db
      .prepare(
        `UPDATE artifacts SET state='VERIFIED',manifest_hash=?,verified_at=? WHERE owner_id=? AND artifact_id=? AND state='UPLOADING' AND (SELECT COUNT(*) FROM artifact_chunks WHERE owner_id=? AND artifact_id=?)=chunk_count AND ${guard.predicate}`,
      )
      .bind(
        manifestHash,
        commitAt.toISOString(),
        this.context.ownerId,
        id,
        this.context.ownerId,
        id,
        ...guard.bindings,
      )
      .run();
    if (result.meta.changes !== 1) throw new Error('STALE_FENCE');
    return this.get(id, token, task, currentTime());
  }
}
