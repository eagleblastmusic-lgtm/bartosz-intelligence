import type { AccessContext, Database } from '../db/boundary.js';
import { assertContext } from '../db/boundary.js';
import type { LeaseToken, TaskType } from '../../../contracts/src/jobs.js';
import { leasePredicate } from '../jobs/lease-guard.js';
import {
  base64url,
  decode64,
  sha256,
  sign,
  verifySigned,
} from '../auth/crypto.js';
import { CheckpointSha256, type HashCheckpoint } from './hash-checkpoint.js';
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
const nativeHashBytes = async (bytes: Uint8Array) =>
  bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
    ),
  );
async function artifactManifestHash(
  header: ArtifactRow,
  offset: number,
  chunkManifestHash: string,
) {
  return sha256(
    JSON.stringify({
      version: 1,
      item_id: header.item_id,
      kind: header.kind,
      content_hash: header.content_hash,
      byte_size: offset,
      chunk_count: header.chunk_count,
      chunk_manifest_hash: chunkManifestHash,
      schema_version: header.schema_version,
      producer_version: header.producer_version,
      provenance: JSON.parse(header.provenance_json),
      original_ref: header.original_ref,
    }),
  );
}
interface VerificationCheckpoint {
  version: 'artifact-verification:1';
  owner_id: string;
  artifact_id: string;
  job_id: string;
  fencing_token: number;
  task: TaskType;
  expires_at: string;
  index: number;
  offset: number;
  content: HashCheckpoint;
  manifest: HashCheckpoint;
}
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
    private diagnosticReservationId: string | null = null,
  ) {
    assertContext(context);
  }
  private guard(token: LeaseToken, task: TaskType, now: Date) {
    if (this.diagnosticReservationId !== null) {
      this.context.requireTask(task);
      if (
        !['ANALYZE', 'TRANSLATE', 'HISTORICAL_COMPARE'].includes(task) ||
        token.lease_owner !== this.context.actorId ||
        !/^[a-f0-9-]{36}$/.test(this.diagnosticReservationId)
      )
        throw new Error('FORBIDDEN');
      return {
        predicate: `EXISTS(SELECT 1 FROM quota_reservations r JOIN jobs q ON q.owner_id=r.owner_id AND q.job_id=r.job_id JOIN job_attempts a ON a.owner_id=r.owner_id AND a.job_id=r.job_id AND a.fencing_token=r.fencing_token JOIN worker_identities w ON w.owner_id=a.owner_id AND w.worker_id=a.executor_id WHERE r.owner_id=? AND r.reservation_id=? AND r.job_id=? AND r.fencing_token=? AND r.state IN ('SUBMITTED','SETTLED','UNKNOWN') AND a.executor_id=? AND w.credential_hash=? AND w.revoked_at IS NULL AND q.task_type=?)`,
        bindings: [
          this.context.ownerId,
          this.diagnosticReservationId,
          token.job_id,
          token.fencing_token,
          this.context.actorId,
          this.context.credentialHash!,
          task,
        ],
      };
    }
    return leasePredicate(this.context, token, now.toISOString(), task);
  }
  async begin(
    descriptor: ArtifactDescriptor,
    token: LeaseToken,
    task: TaskType,
    now: Date,
  ) {
    if (
      this.diagnosticReservationId !== null &&
      (descriptor.kind !== 'ANALYSIS_CANDIDATE' ||
        descriptor.original_ref !== null ||
        descriptor.schema_version !== 'provider-output:1' ||
        descriptor.producer_version !==
          'gemini-response:1:' + this.diagnosticReservationId ||
        descriptor.provenance.reservation_id !== this.diagnosticReservationId)
    )
      throw new Error('INVALID_DIAGNOSTIC_ARTIFACT');
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
    if (
      this.context.kind === 'worker' &&
      this.context.scopes.includes('DRIVE_EXPORT') &&
      !token &&
      !task
    ) {
      this.context.requireTask('DRIVE_EXPORT');
      filter = ` AND state='VERIFIED' AND kind='ANALYSIS_CANDIDATE' AND schema_version='intelligence-canonical:1.2' AND EXISTS(SELECT 1 FROM analysis_runs r WHERE r.owner_id=artifacts.owner_id AND r.item_id=artifacts.item_id AND r.state='ACCEPTED' AND json_extract(r.outcome_json,'$.version')='intelligence-accepted:1' AND json_extract(r.outcome_json,'$.canonical_artifact_id')=artifacts.artifact_id AND json_extract(r.outcome_json,'$.canonical_hash')=artifacts.content_hash)`;
    } else if (this.context.kind === 'worker') {
      if (!token || !task) throw new Error('FORBIDDEN');
      const guard = this.guard(token, task, now);
      filter = ` AND ${guard.predicate} AND EXISTS(SELECT 1 FROM jobs WHERE owner_id=? AND job_id=? AND item_id=artifacts.item_id)`;
      bindings = [...guard.bindings, this.context.ownerId, token.job_id];
      if (this.diagnosticReservationId !== null) {
        filter += ` AND kind='ANALYSIS_CANDIDATE' AND json_extract(provenance_json,'$.reservation_id')=?`;
        bindings = [...bindings, this.diagnosticReservationId];
      }
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
  async readVerifiedText(
    id: string,
    maximumBytes: number,
    token?: LeaseToken,
    task?: TaskType,
    now = new Date(),
  ) {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > 32 * 1024 * 1024
    )
      throw new Error('INVALID_ARTIFACT_READ_LIMIT');
    const started = Date.now(),
      current = () => new Date(now.getTime() + Date.now() - started);
    const artifact = await this.get(id, token, task, current());
    if (artifact.state !== 'VERIFIED' || artifact.byte_size > maximumBytes)
      throw new Error('VERIFIED_ARTIFACT_REQUIRED');
    const bytes = new Uint8Array(artifact.byte_size);
    let offset = 0;
    for (let index = 0; index < artifact.chunk_count; index++) {
      const chunk = await this.chunk(id, index, token, task, current());
      const part = chunk.body_base64
        ? decode64(chunk.body_base64)
        : new Uint8Array();
      if (chunk.byte_start !== offset || offset + part.length > bytes.length)
        throw new Error('ARTIFACT_CHUNK_ORDER_INVALID');
      bytes.set(part, offset);
      offset += part.length;
    }
    if (
      offset !== artifact.byte_size ||
      (await nativeHashBytes(bytes)) !== artifact.content_hash
    )
      throw new Error('ARTIFACT_CONTENT_HASH_MISMATCH');
    return {
      artifact,
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes,
      ),
    };
  }
  async readOwnerPage(id: string, start: number, limit = 4) {
    this.context.requireOwner();
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 4
    )
      throw new Error('INVALID_ARTIFACT_READ_LIMIT');
    const artifact = await this.get(id);
    if (artifact.state !== 'VERIFIED' || start >= artifact.chunk_count)
      throw new Error('VERIFIED_ARTIFACT_REQUIRED');
    const chunks = (
      await this.db
        .prepare(
          'SELECT * FROM artifact_chunks WHERE owner_id=? AND artifact_id=? AND chunk_index>=? AND chunk_index<? ORDER BY chunk_index',
        )
        .bind(
          this.context.ownerId,
          id,
          start,
          Math.min(start + limit, artifact.chunk_count),
        )
        .all<ArtifactChunk>()
    ).results;
    if (chunks.length !== Math.min(limit, artifact.chunk_count - start))
      throw new Error('ARTIFACT_CHUNK_MISSING');
    let offset = chunks[0]!.byte_start;
    if (offset < 0 || (start === 0 && offset !== 0))
      throw new Error('ARTIFACT_CHUNK_ORDER_INVALID');
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!,
        bytes = chunk.body_base64
          ? decode64(chunk.body_base64)
          : new Uint8Array();
      if (
        chunk.chunk_index !== start + index ||
        chunk.byte_start !== offset ||
        bytes.length !== chunk.byte_size ||
        bytes.length > artifactChunkBytes ||
        (await nativeHashBytes(bytes)) !== chunk.byte_hash ||
        chunk.storage_ref !== `d1:${id}/${chunk.chunk_index}`
      )
        throw new Error('ARTIFACT_CHUNK_CORRUPT');
      offset += bytes.length;
    }
    if (
      offset > artifact.byte_size ||
      (start + chunks.length === artifact.chunk_count &&
        offset !== artifact.byte_size)
    )
      throw new Error('ARTIFACT_CHUNK_ORDER_INVALID');
    return {
      artifact,
      chunks,
      next_index:
        start + chunks.length < artifact.chunk_count
          ? start + chunks.length
          : null,
    };
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
    const hash = await nativeHashBytes(bytes),
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
      (await nativeHashBytes(bytes)) !== row.byte_hash ||
      row.storage_ref !== `d1:${id}/${index}`
    )
      throw new Error('ARTIFACT_CHUNK_CORRUPT');
    return row;
  }
  async verifyStep(
    id: string,
    token: LeaseToken,
    task: TaskType,
    now: Date,
    secret: string,
    proof?: string,
  ) {
    if (secret.length < 32) throw new Error('SESSION_SECRET_REQUIRED');
    const header = await this.get(id, token, task, now);
    let state: VerificationCheckpoint;
    if (proof !== undefined) {
      if (proof.length > 8192)
        throw new Error('INVALID_VERIFICATION_CHECKPOINT');
      const encoded = await verifySigned(proof, secret);
      state = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
          decode64(encoded),
        ),
      ) as VerificationCheckpoint;
      if (
        state.version !== 'artifact-verification:1' ||
        state.owner_id !== this.context.ownerId ||
        state.artifact_id !== id ||
        state.job_id !== token.job_id ||
        state.fencing_token !== token.fencing_token ||
        state.task !== task ||
        !Number.isFinite(Date.parse(state.expires_at)) ||
        state.expires_at <= now.toISOString() ||
        !Number.isSafeInteger(state.index) ||
        state.index < 0 ||
        state.index >= header.chunk_count ||
        !Number.isSafeInteger(state.offset) ||
        state.offset < 0 ||
        state.offset > header.byte_size
      )
        throw new Error('INVALID_VERIFICATION_CHECKPOINT');
    } else
      state = {
        version: 'artifact-verification:1',
        owner_id: this.context.ownerId,
        artifact_id: id,
        job_id: token.job_id,
        fencing_token: token.fencing_token,
        task,
        expires_at: new Date(now.getTime() + 900000).toISOString(),
        index: 0,
        offset: 0,
        content: new CheckpointSha256().snapshot(),
        manifest: new CheckpointSha256().snapshot(),
      };
    const content = CheckpointSha256.restore(state.content),
      manifest = CheckpointSha256.restore(state.manifest);
    if (state.content.length !== state.offset)
      throw new Error('INVALID_VERIFICATION_CHECKPOINT');
    const chunk = await this.chunk(id, state.index, token, task, now);
    if (chunk.byte_start !== state.offset)
      throw new Error('ARTIFACT_RANGE_MISMATCH');
    content.update(
      chunk.body_base64 ? decode64(chunk.body_base64) : new Uint8Array(),
    );
    manifest.update(
      new TextEncoder().encode(
        JSON.stringify({
          index: state.index,
          start: state.offset,
          bytes: chunk.byte_size,
          hash: chunk.byte_hash,
        }) + '\n',
      ),
    );
    state.index++;
    state.offset += chunk.byte_size;
    if (state.index < header.chunk_count) {
      state.content = content.snapshot();
      state.manifest = manifest.snapshot();
      const encoded = base64url(
        new TextEncoder().encode(JSON.stringify(state)),
      );
      return {
        complete: false,
        proof: encoded + '.' + (await sign(encoded, secret)),
        next_index: state.index,
        artifact: null,
      };
    }
    if (
      state.offset !== header.byte_size ||
      bytesToHex(content.digest()) !== header.content_hash
    )
      throw new Error('ARTIFACT_CONTENT_MISMATCH');
    const manifestHash = await artifactManifestHash(
      header,
      state.offset,
      bytesToHex(manifest.digest()),
    );
    await this.seal(header, manifestHash, token, task, now);
    return {
      complete: true,
      proof: null,
      next_index: null,
      artifact: await this.get(id, token, task, now),
    };
  }
  private async seal(
    header: ArtifactRow,
    manifestHash: string,
    token: LeaseToken,
    task: TaskType,
    now: Date,
  ) {
    if (header.state === 'VERIFIED') {
      if (header.manifest_hash !== manifestHash)
        throw new Error('ARTIFACT_MANIFEST_MISMATCH');
      return;
    }
    const guard = this.guard(token, task, now);
    const result = await this.db
      .prepare(
        `UPDATE artifacts SET state='VERIFIED',manifest_hash=?,verified_at=? WHERE owner_id=? AND artifact_id=? AND state='UPLOADING' AND (SELECT COUNT(*) FROM artifact_chunks WHERE owner_id=? AND artifact_id=?)=chunk_count AND ${guard.predicate}`,
      )
      .bind(
        manifestHash,
        now.toISOString(),
        this.context.ownerId,
        header.artifact_id,
        this.context.ownerId,
        header.artifact_id,
        ...guard.bindings,
      )
      .run();
    if (result.meta.changes !== 1) throw new Error('STALE_FENCE');
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
    const manifestHash = await artifactManifestHash(
      header,
      offset,
      bytesToHex(manifest.digest()),
    );
    if (header.state === 'VERIFIED') {
      if (header.manifest_hash !== manifestHash)
        throw new Error('ARTIFACT_MANIFEST_MISMATCH');
      return this.get(id, token, task, currentTime());
    }
    const commitAt = currentTime();
    await this.seal(header, manifestHash, token, task, commitAt);
    return this.get(id, token, task, currentTime());
  }
}
