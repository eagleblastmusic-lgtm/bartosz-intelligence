import { assertContext, AccessContext, type Database } from '../db/boundary.js';
import { sha256, decode64 } from '../auth/crypto.js';
import {
  DriveFailure,
  type DriveClient,
  type DriveFile,
} from '../drive/client.js';
import type { ArtifactRow, ArtifactChunk } from '../artifacts/store.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface PayloadArchiveReceipt {
  owner_id: string;
  source_artifact_id: string;
  item_id: string;
  folder_id: string;
  connection_id: string;
  reserved_file_id: string;
  content_hash: string;
  artifact_ids_json: string;
  state: 'PENDING' | 'VERIFIED';
  remote_version: string | null;
  verified_at: string | null;
}
export interface TranscriptPayloadPackage {
  version: 'transcript-payload:1';
  owner_id: string;
  source_artifact_id: string;
  item: Record<string, unknown>;
  artifacts: { header: ArtifactRow; chunks: ArtifactChunk[] }[];
}
/** Exact bytes and original chunk boundaries for the THREE compact artifacts.
 * No renormalization, no packaging of legacy AI manifests. */
export class TranscriptPayloadArchive {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async ensure(
    sourceId: string,
    client: DriveClient,
    folder: string,
    connectionId: string,
    now: Date,
    guard: () => Promise<void>,
  ) {
    this.context.requireOwnerOrTask('DRIVE_EXPORT');
    const accepted = await this.db
      .prepare(
        "SELECT r.item_id,r.outcome_json FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.state='ACCEPTED' AND j.state='SUCCEEDED' AND j.task_type='FETCH_TRANSCRIPT' AND json_extract(r.outcome_json,'$.version')='transcript-source:2' AND json_extract(r.outcome_json,'$.source_artifact_id')=? LIMIT 1",
      )
      .bind(this.context.ownerId, sourceId)
      .first<{ item_id: string; outcome_json: string }>();
    if (!accepted) return; // Legacy remains local; never eligible for this eviction.
    let receipt = await this.db
      .prepare(
        'SELECT * FROM transcript_payload_archives WHERE owner_id=? AND source_artifact_id=?',
      )
      .bind(this.context.ownerId, sourceId)
      .first<PayloadArchiveReceipt>();
    if (receipt?.state === 'VERIFIED')
      return { ...receipt, already_verified: true };
    const outcome = JSON.parse(accepted.outcome_json) as {
      raw_artifact_id: string;
      source_artifact_id: string;
      segment_map_artifact_id: string;
    };
    const ids = [
      outcome.raw_artifact_id,
      sourceId,
      outcome.segment_map_artifact_id,
    ];
    const item = await this.db
      .prepare(
        "SELECT i.item_id,i.source_id,i.namespace,i.external_id,i.canonical_url,s.namespace source_namespace,CASE WHEN s.namespace='youtube' THEN s.external_id ELSE NULL END channel_id FROM items i JOIN sources s USING(owner_id,source_id) WHERE i.owner_id=? AND i.item_id=?",
      )
      .bind(this.context.ownerId, accepted.item_id)
      .first<Record<string, unknown>>();
    if (!item) throw new Error('PAYLOAD_ARCHIVE_SOURCE_MISMATCH');
    const entries: TranscriptPayloadPackage['artifacts'] = [];
    for (const id of ids) {
      const header = await this.db
        .prepare(
          "SELECT * FROM artifacts WHERE owner_id=? AND item_id=? AND artifact_id=? AND state='VERIFIED'",
        )
        .bind(this.context.ownerId, accepted.item_id, id)
        .first<ArtifactRow>();
      if (!header) throw new Error('PAYLOAD_ARCHIVE_SOURCE_MISMATCH');
      const chunks: ArtifactChunk[] = [];
      for (let start = 0; start < header.chunk_count; start += 64)
        chunks.push(
          ...(
            await this.db
              .prepare(
                'SELECT * FROM artifact_chunks WHERE owner_id=? AND artifact_id=? AND chunk_index>=? AND chunk_index<? ORDER BY chunk_index',
              )
              .bind(this.context.ownerId, id, start, start + 64)
              .all<ArtifactChunk>()
          ).results,
        );
      entries.push({ header, chunks });
    }
    const payload: TranscriptPayloadPackage = {
      version: 'transcript-payload:1',
      owner_id: this.context.ownerId,
      source_artifact_id: sourceId,
      item,
      artifacts: entries,
    };
    await verifyPayloadPackage(payload, this.context.ownerId, sourceId, ids);
    const text = JSON.stringify(payload),
      hash = await sha256(text);
    if (new TextEncoder().encode(text).length > 32 * 1024 * 1024)
      throw new Error('PAYLOAD_ARCHIVE_TOO_LARGE');
    if (receipt && receipt.content_hash !== hash)
      throw new Error('PAYLOAD_ARCHIVE_CONFLICT');
    if (!receipt) {
      const id = await client.reserveId();
      await guard();
      await this.db
        .prepare(
          "INSERT INTO transcript_payload_archives(owner_id,source_artifact_id,item_id,folder_id,connection_id,reserved_file_id,content_hash,artifact_ids_json,state) VALUES(?,?,?,?,?,?,?,?,'PENDING') ON CONFLICT DO NOTHING",
        )
        .bind(
          this.context.ownerId,
          sourceId,
          accepted.item_id,
          folder,
          connectionId,
          id,
          hash,
          JSON.stringify(ids),
        )
        .run();
      receipt = (await this.db
        .prepare(
          'SELECT * FROM transcript_payload_archives WHERE owner_id=? AND source_artifact_id=?',
        )
        .bind(this.context.ownerId, sourceId)
        .first<PayloadArchiveReceipt>())!;
      if (receipt.content_hash !== hash)
        throw new Error('PAYLOAD_ARCHIVE_CONFLICT');
    }
    const properties = {
      bi_owner: await sha256(this.context.ownerId),
      bi_source: await sha256(sourceId),
    };
    let file: DriveFile;
    try {
      file = await client.getFile(receipt.reserved_file_id);
    } catch (error) {
      if (!(error instanceof DriveFailure) || error.category !== 'NOT_FOUND')
        throw error;
      await guard();
      try {
        file = await client.createTranscriptPackage({
          reserved_id: receipt.reserved_file_id,
          root_id: receipt.folder_id,
          name: `${sourceId}.json`,
          markdown: text,
          app_properties: properties,
        });
      } catch (error) {
        if (
          !(error instanceof DriveFailure) ||
          !['TRANSPORT', 'TRANSIENT', 'CONFLICT'].includes(error.category)
        )
          throw error;
        file = await client.getFile(receipt.reserved_file_id);
      }
    }
    await this.verify(receipt, client, file);
    await guard();
    await this.db
      .prepare(
        "UPDATE transcript_payload_archives SET state='VERIFIED',remote_version=?,verified_at=? WHERE owner_id=? AND source_artifact_id=? AND reserved_file_id=? AND content_hash=? AND state='PENDING'",
      )
      .bind(
        file.version!,
        now.toISOString(),
        this.context.ownerId,
        sourceId,
        receipt.reserved_file_id,
        hash,
      )
      .run();
    return {
      ...receipt,
      state: 'VERIFIED' as const,
      remote_version: file.version!,
      verified_at: now.toISOString(),
      already_verified: false,
    };
  }
  async verify(
    receipt: PayloadArchiveReceipt,
    client: DriveClient,
    before?: DriveFile,
  ) {
    const first = before ?? (await client.getFile(receipt.reserved_file_id));
    await client.verifyPrivateFolder(receipt.folder_id);
    await client.verifyPrivateFolder(receipt.reserved_file_id);
    const text = await client.readTranscriptMarkdown(receipt.reserved_file_id),
      after = await client.getFile(receipt.reserved_file_id);
    if (
      first.version !== after.version ||
      !after.version ||
      after.id !== receipt.reserved_file_id ||
      after.trashed !== false ||
      after.mimeType !== 'application/json' ||
      !after.parents?.includes(receipt.folder_id) ||
      after.appProperties?.bi_owner !== (await sha256(receipt.owner_id)) ||
      after.appProperties?.bi_source !==
        (await sha256(receipt.source_artifact_id)) ||
      receipt.owner_id !== this.context.ownerId ||
      (await sha256(text)) !== receipt.content_hash
    )
      throw new Error('PAYLOAD_ARCHIVE_INTEGRITY_FAILED');
    const payload = JSON.parse(text) as TranscriptPayloadPackage;
    await verifyPayloadPackage(
      payload,
      receipt.owner_id,
      receipt.source_artifact_id,
      JSON.parse(receipt.artifact_ids_json),
    );
    if (
      receipt.remote_version !== null &&
      receipt.remote_version !== after.version
    ) {
      // Drive may advance metadata after create without changing any bytes.
      // Reconcile only after the stable, private, exact full-package readback.
      this.context.requireOwnerOrTask('DRIVE_EXPORT');
      if (this.context.kind === 'worker')
        (
          await AccessContext.worker(this.db, this.context.credentialHash!)
        ).requireTask('DRIVE_EXPORT');
      if (
        !/^[1-9]\d*$/.test(receipt.remote_version) ||
        !/^[1-9]\d*$/.test(after.version) ||
        BigInt(after.version) <= BigInt(receipt.remote_version)
      )
        throw new Error('PAYLOAD_ARCHIVE_INTEGRITY_FAILED');
      const at = new Date().toISOString();
      const saved = await this.db
        .prepare(
          `UPDATE transcript_payload_archives SET remote_version=?
         WHERE owner_id=? AND source_artifact_id=? AND item_id=? AND state='VERIFIED'
         AND reserved_file_id=? AND folder_id=? AND connection_id=?
         AND content_hash=? AND artifact_ids_json=? AND remote_version=?
         AND (permit_token IS NULL OR permit_until<=?)
         AND NOT EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=transcript_payload_archives.owner_id AND t.item_id=transcript_payload_archives.item_id AND t.phase IN ('PRUNING','COMPLETE'))`,
        )
        .bind(
          after.version,
          receipt.owner_id,
          receipt.source_artifact_id,
          receipt.item_id,
          receipt.reserved_file_id,
          receipt.folder_id,
          receipt.connection_id,
          receipt.content_hash,
          receipt.artifact_ids_json,
          receipt.remote_version,
          at,
        )
        .run();
      if (saved.meta.changes !== 1)
        throw new Error('PAYLOAD_ARCHIVE_STALE_RECEIPT');
      // Callers granting a later eviction permit must bind the verified version.
      // Acquisition time, hashes, IDs and immutable artifact data stay unchanged.
      receipt.remote_version = after.version;
    }
    return payload;
  }
  /** Authorization is checked by ArtifactRepository before calling this reader. */
  async read(
    header: ArtifactRow,
    client: (connectionId: string) => Promise<DriveClient>,
  ) {
    const receipt = await this.db
      .prepare(
        "SELECT * FROM transcript_payload_archives WHERE owner_id=? AND item_id=? AND state='VERIFIED' AND ? IN (SELECT value FROM json_each(artifact_ids_json)) LIMIT 1",
      )
      .bind(this.context.ownerId, header.item_id, header.artifact_id)
      .first<PayloadArchiveReceipt>();
    if (!receipt) throw new Error('ARTIFACT_CHUNK_MISSING');
    const payload = await this.verify(
      receipt,
      await client(receipt.connection_id),
    );
    const entry = payload.artifacts.find(
      (a) => a.header.artifact_id === header.artifact_id,
    );
    if (!entry || JSON.stringify(entry.header) !== JSON.stringify(header))
      throw new Error('PAYLOAD_ARCHIVE_DESCRIPTOR_MISMATCH');
    return entry.chunks;
  }
}
export async function verifyPayloadPackage(
  p: TranscriptPayloadPackage,
  owner: string,
  sourceId: string,
  ids: string[],
) {
  if (
    p?.version !== 'transcript-payload:1' ||
    p.owner_id !== owner ||
    p.source_artifact_id !== sourceId ||
    !Array.isArray(p.artifacts) ||
    p.artifacts.length !== 3 ||
    p.artifacts.map((e) => e.header.artifact_id).join(',') !== ids.join(',') ||
    p.artifacts.map((e) => e.header.kind).join(',') !==
      'RAW,SOURCE_ORIGINAL,SEGMENT_MAP' ||
    p.artifacts[2]!.header.schema_version !== 'caption-coverage:1'
  )
    throw new Error('PAYLOAD_ARCHIVE_SOURCE_MISMATCH');
  for (const { header: h, chunks } of p.artifacts) {
    if (
      h.owner_id !== owner ||
      h.item_id !== p.item.item_id ||
      chunks.length !== h.chunk_count ||
      h.byte_size > 32 * 1024 * 1024
    )
      throw new Error('PAYLOAD_ARCHIVE_SOURCE_MISMATCH');
    const bytes = new Uint8Array(h.byte_size);
    let offset = 0;
    for (const [i, c] of chunks.entries()) {
      const part = decode64(c.body_base64);
      if (
        c.owner_id !== owner ||
        c.artifact_id !== h.artifact_id ||
        c.item_id !== h.item_id ||
        c.chunk_index !== i ||
        c.byte_start !== offset ||
        c.byte_size !== part.length ||
        part.length > 32768 ||
        offset + part.length > bytes.length ||
        c.storage_ref !== `d1:${h.artifact_id}/${i}` ||
        bytesToHex(
          new Uint8Array(await crypto.subtle.digest('SHA-256', part)),
        ) !== c.byte_hash
      )
        throw new Error('PAYLOAD_ARCHIVE_INTEGRITY_FAILED');
      bytes.set(part, offset);
      offset += part.length;
    }
    if (
      offset !== bytes.length ||
      bytesToHex(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      ) !== h.content_hash
    )
      throw new Error('PAYLOAD_ARCHIVE_INTEGRITY_FAILED');
  }
}
