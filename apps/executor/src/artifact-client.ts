import type {
  ArtifactDescriptor,
  ArtifactRow,
  ArtifactChunk,
} from '../../../packages/core/src/artifacts/store.js';
import { splitArtifactText } from '../../../packages/core/src/artifacts/store.js';
import {
  base64url,
  decode64,
  sha256,
} from '../../../packages/core/src/auth/crypto.js';
import type {
  LeaseToken,
  TaskType,
} from '../../../packages/contracts/src/jobs.js';
import { WorkerRpc, WorkerRpcError } from './worker-rpc.js';
export class ArtifactClient {
  private connection: WorkerRpc;
  constructor(
    origin: string,
    credential: string,
    private lease: () => LeaseToken,
    private task: TaskType,
    transport: typeof fetch = fetch,
    private diagnosticReservationId: string | null = null,
    private wait: (milliseconds: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.connection = new WorkerRpc(origin, credential, transport);
  }
  private async rpc(path: string, input: Record<string, unknown>) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.connection.request('artifacts/' + path, {
          task_type: this.task,
          token: this.lease(),
          ...(this.diagnosticReservationId === null
            ? {}
            : { reservation_id: this.diagnosticReservationId }),
          ...input,
        });
      } catch (error) {
        // Chunk INSERT is content-addressed and verifies an existing duplicate.
        // Other RPC mutations and explicit quota/auth/fence failures never retry.
        if (
          path === 'write' &&
          attempt < 2 &&
          error instanceof WorkerRpcError &&
          [429, 502, 503, 504].includes(error.status) &&
          (error.code === null ||
            error.code === 'TRANSIENT' ||
            error.code === 'BACKUP_BUSY')
        ) {
          await this.wait(
            Math.max(
              [500, 1500][attempt]!,
              error.retry_after_ms ?? (error.status === 429 ? 30000 : 0),
            ),
          );
          continue;
        }
        if (error instanceof Error && error.message === 'WORKER_RPC_FAILED')
          throw error instanceof WorkerRpcError
            ? new WorkerRpcError(
                'ARTIFACT_RPC_FAILED',
                error.route,
                error.status,
                error.code,
                error.retry_after_ms,
              )
            : new Error('ARTIFACT_RPC_FAILED');
        throw error;
      }
    }
  }
  async upload(
    text: string,
    descriptor: Omit<
      ArtifactDescriptor,
      'content_hash' | 'byte_size' | 'chunk_count'
    >,
  ) {
    const chunks = splitArtifactText(text);
    const artifact = (await this.rpc('begin', {
      descriptor: {
        ...descriptor,
        content_hash: await sha256(text),
        byte_size: new TextEncoder().encode(text).length,
        chunk_count: chunks.length,
      },
    })) as ArtifactRow;
    if (artifact.state === 'VERIFIED') return artifact;
    let offset = 0;
    for (let index = 0; index < chunks.length; index++) {
      await this.rpc('write', {
        artifact_id: artifact.artifact_id,
        chunk_index: index,
        byte_start: offset,
        body_base64: chunks[index]!.length ? base64url(chunks[index]!) : '',
      });
      offset += chunks[index]!.length;
    }
    let proof: string | undefined;
    for (let index = 0; index < chunks.length; index++) {
      const result = (await this.rpc('verify-step', {
        artifact_id: artifact.artifact_id,
        ...(proof ? { proof } : {}),
      })) as {
        complete: boolean;
        proof: string | null;
        next_index: number | null;
        artifact: ArtifactRow | null;
      };
      if (result.complete) {
        if (
          !result.artifact ||
          result.artifact.content_hash !== (await sha256(text))
        )
          throw new Error('ARTIFACT_RPC_HASH_MISMATCH');
        return result.artifact;
      }
      if (result.next_index !== index + 1 || !result.proof)
        throw new Error('INVALID_ARTIFACT_RPC_CHECKPOINT');
      proof = result.proof;
    }
    throw new Error('ARTIFACT_VERIFICATION_INCOMPLETE');
  }
  async readText(id: string) {
    const header = (
      (await this.rpc('read', { artifact_id: id })) as { artifact: ArtifactRow }
    ).artifact;
    if (
      header.artifact_id !== id ||
      header.state !== 'VERIFIED' ||
      !Number.isSafeInteger(header.byte_size) ||
      header.byte_size < 0 ||
      header.byte_size > 33554432 ||
      !Number.isSafeInteger(header.chunk_count) ||
      header.chunk_count < 1 ||
      header.chunk_count > 1024
    )
      throw new Error('INVALID_ARTIFACT_READ');
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (let index = 0; index < header.chunk_count; index++) {
      const chunk = (
        (await this.rpc('read', { artifact_id: id, chunk_index: index })) as {
          chunk: ArtifactChunk;
        }
      ).chunk;
      const bytes = chunk.body_base64
        ? decode64(chunk.body_base64)
        : new Uint8Array();
      if (chunk.byte_start !== offset || chunk.byte_size !== bytes.length)
        throw new Error('ARTIFACT_RPC_RANGE_MISMATCH');
      parts.push(bytes);
      offset += bytes.length;
    }
    if (offset !== header.byte_size)
      throw new Error('ARTIFACT_RPC_RANGE_MISMATCH');
    const bytes = new Uint8Array(offset);
    offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if ((await sha256(text)) !== header.content_hash)
      throw new Error('ARTIFACT_RPC_HASH_MISMATCH');
    return { artifact: header, text };
  }
}
