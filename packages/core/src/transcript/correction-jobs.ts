import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
import { JobStore } from '../jobs/store.js';
import { leasePredicate } from '../jobs/lease-guard.js';
import { RunRepository } from '../jobs/acceptance.js';
import { ArtifactRepository } from '../artifacts/store.js';
import type { LeaseToken } from '../../../contracts/src/jobs.js';
import type { SourceCorrectionPatch } from './corrected-source.js';

export interface SourceCorrectionSnapshot {
  version: 'source-correction-job:1';
  item_id: string;
  source_run_id: string;
  original_ref: string;
  original_hash: string;
  segment_map_artifact_id: string;
  manifest_hash: string;
  language_code: string;
  authored_by: string;
  reason: string;
  patches: SourceCorrectionPatch[];
}
export class SourceCorrectionJobs {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async enqueueArtifact(
    artifactId: string,
    patches: SourceCorrectionPatch[],
    reason: string,
    nonce: string,
    now: Date,
  ) {
    this.context.requireOwner();
    const row = await this.db
      .prepare(
        `SELECT r.run_id FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.state='ACCEPTED' AND j.task_type='FETCH_TRANSCRIPT' AND j.state='SUCCEEDED' AND json_extract(r.outcome_json,'$.source_artifact_id')=? ORDER BY r.created_at DESC LIMIT 1`,
      )
      .bind(this.context.ownerId, artifactId)
      .first<{ run_id: string }>();
    if (!row) throw new Error('ANALYSIS_SOURCE_NOT_ACCEPTED');
    return this.enqueue(row.run_id, patches, reason, nonce, now);
  }
  async enqueue(
    sourceRunId: string,
    patches: SourceCorrectionPatch[],
    reason: string,
    nonce: string,
    now: Date,
  ) {
    this.context.requireOwner();
    if (
      !/^[a-f0-9-]{36}$/.test(nonce) ||
      !reason.trim() ||
      reason.length > 2000 ||
      !Array.isArray(patches) ||
      patches.length < 1 ||
      patches.length > 100 ||
      patches.some(
        (patch) =>
          !patch ||
          Object.keys(patch).some(
            (key) =>
              ![
                'source_start',
                'source_end',
                'old_value',
                'new_value',
              ].includes(key),
          ) ||
          !Number.isSafeInteger(patch.source_start) ||
          !Number.isSafeInteger(patch.source_end) ||
          patch.source_start < 0 ||
          patch.source_end <= patch.source_start ||
          typeof patch.old_value !== 'string' ||
          typeof patch.new_value !== 'string' ||
          !patch.new_value.trim() ||
          /[\r\n\uD800-\uDFFF]/u.test(patch.new_value) ||
          new TextEncoder().encode(patch.new_value).length > 20000,
      )
    )
      throw new Error('INVALID_SOURCE_CORRECTION');
    const row = await this.db
      .prepare(
        `SELECT r.item_id,r.outcome_json,r.candidate_hash FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.run_id=? AND r.state='ACCEPTED' AND j.task_type='FETCH_TRANSCRIPT' AND j.state='SUCCEEDED'`,
      )
      .bind(this.context.ownerId, sourceRunId)
      .first<{
        item_id: string;
        outcome_json: string;
        candidate_hash: string;
      }>();
    if (!row || (await sha256(row.outcome_json)) !== row.candidate_hash)
      throw new Error('ANALYSIS_SOURCE_NOT_ACCEPTED');
    const source = JSON.parse(row.outcome_json) as {
      version: string;
      source_artifact_id: string;
      segment_map_artifact_id: string;
      source_hash: string;
      authority: { language_code: string; authority_confidence: string };
    };
    if (
      source.version !== 'transcript-source:1' ||
      source.authority?.authority_confidence !== 'CONFIRMED'
    )
      throw new Error('ANALYSIS_SOURCE_AUTHORITY_REQUIRED');
    const pair = await this.db
      .prepare(
        `SELECT m.content_hash manifest_hash FROM artifacts s JOIN artifacts m ON m.owner_id=s.owner_id AND m.item_id=s.item_id AND m.original_ref=s.artifact_id WHERE s.owner_id=? AND s.item_id=? AND s.artifact_id=? AND s.content_hash=? AND s.kind='SOURCE_ORIGINAL' AND s.state='VERIFIED' AND m.artifact_id=? AND m.kind='SEGMENT_MAP' AND m.state='VERIFIED' AND (m.producer_version='source-normalizer:1' OR (length(s.producer_version)=length('yt-dlp@2026.08.19+yt-dlp-ejs@0.8.0:archive-source:1:')+64 AND substr(s.producer_version,1,length('yt-dlp@2026.08.19+yt-dlp-ejs@0.8.0:archive-source:1:'))='yt-dlp@2026.08.19+yt-dlp-ejs@0.8.0:archive-source:1:' AND m.producer_version=replace(s.producer_version,'yt-dlp@2026.08.19+yt-dlp-ejs@0.8.0','source-normalizer:1')))`,
      )
      .bind(
        this.context.ownerId,
        row.item_id,
        source.source_artifact_id,
        source.source_hash,
        source.segment_map_artifact_id,
      )
      .first<{ manifest_hash: string }>();
    if (!pair) throw new Error('ANALYSIS_SOURCE_ARTIFACT_MISMATCH');
    const snapshot: SourceCorrectionSnapshot = {
      version: 'source-correction-job:1',
      item_id: row.item_id,
      source_run_id: sourceRunId,
      original_ref: source.source_artifact_id,
      original_hash: source.source_hash,
      segment_map_artifact_id: source.segment_map_artifact_id,
      manifest_hash: pair.manifest_hash,
      language_code: source.authority.language_code,
      authored_by: this.context.ownerId,
      reason: reason.trim(),
      patches: patches.map((patch) => ({
        source_start: patch.source_start,
        source_end: patch.source_end,
        old_value: patch.old_value,
        new_value: patch.new_value,
      })),
    };
    if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 60000)
      throw new Error('INVALID_SOURCE_CORRECTION');
    const revision = await sha256(JSON.stringify(snapshot));
    const existing = await this.db
      .prepare(
        "SELECT job_id,input_revision FROM jobs WHERE owner_id=? AND profile_revision='owner-source-correction:1' AND explicit_run_nonce=?",
      )
      .bind(this.context.ownerId, nonce)
      .first<{ job_id: string; input_revision: string }>();
    if (existing) {
      if (existing.input_revision !== revision)
        throw new Error('IDEMPOTENCY_CONFLICT');
      return new JobStore(this.db, this.context).get(existing.job_id);
    }
    return new JobStore(this.db, this.context)
      .enqueue(
        {
          item_id: row.item_id,
          source_id: null,
          task_type: 'NORMALIZE',
          input_revision: revision,
          profile_revision: 'owner-source-correction:1',
          prompt_snapshot_id: null,
          routing_policy_version: 'local-source-correction:1',
          wire_schema_version: null,
          canonical_schema_version: null,
          enrichment_version: null,
          explicit_run_nonce: nonce,
          arrival_origin_at: now.toISOString(),
          origin_kind: 'MANUAL',
          payload: snapshot as unknown as Record<string, unknown>,
          priority: 50,
          due_at: now.toISOString(),
        },
        now.toISOString(),
      )
      .catch(async (error: unknown) => {
        const raced = await this.db
          .prepare(
            "SELECT job_id,input_revision FROM jobs WHERE owner_id=? AND profile_revision='owner-source-correction:1' AND explicit_run_nonce=?",
          )
          .bind(this.context.ownerId, nonce)
          .first<{ job_id: string; input_revision: string }>();
        if (!raced) throw error;
        if (raced.input_revision !== revision)
          throw new Error('IDEMPOTENCY_CONFLICT');
        return new JobStore(this.db, this.context).get(raced.job_id);
      });
  }
  async input(token: LeaseToken, now: Date) {
    const guard = leasePredicate(
      this.context,
      token,
      now.toISOString(),
      'NORMALIZE',
    );
    const job = await this.db
      .prepare(
        `SELECT payload_json,input_revision FROM jobs WHERE owner_id=? AND job_id=? AND profile_revision='owner-source-correction:1' AND ${guard.predicate}`,
      )
      .bind(this.context.ownerId, token.job_id, ...guard.bindings)
      .first<{ payload_json: string; input_revision: string }>();
    if (!job) throw new Error('STALE_FENCE');
    if ((await sha256(job.payload_json)) !== job.input_revision)
      throw new Error('SOURCE_CORRECTION_SNAPSHOT_INVALID');
    const snapshot = JSON.parse(job.payload_json) as SourceCorrectionSnapshot;
    if (
      snapshot.version !== 'source-correction-job:1' ||
      snapshot.authored_by !== this.context.ownerId
    )
      throw new Error('SOURCE_CORRECTION_SNAPSHOT_INVALID');
    const runId = 'source-correction-' + token.job_id;
    await new RunRepository(this.db, this.context).prepare(
      runId,
      token.job_id,
      now.toISOString(),
    );
    return { snapshot, run_id: runId };
  }
  async complete(
    token: LeaseToken,
    sourceArtifactId: string,
    manifestArtifactId: string,
    now: Date,
  ) {
    this.context.requireTask('NORMALIZE');
    if (token.lease_owner !== this.context.actorId)
      throw new Error('STALE_FENCE');
    const replay = await this.db
      .prepare(
        `SELECT r.outcome_json,r.candidate_hash FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id JOIN job_attempts a ON a.owner_id=j.owner_id AND a.job_id=j.job_id JOIN worker_identities w ON w.owner_id=a.owner_id AND w.worker_id=a.executor_id WHERE r.owner_id=? AND j.job_id=? AND j.task_type='NORMALIZE' AND j.profile_revision='owner-source-correction:1' AND j.state='SUCCEEDED' AND r.state='ACCEPTED' AND a.fencing_token=? AND a.executor_id=? AND a.finished_at IS NOT NULL AND w.revoked_at IS NULL AND w.credential_hash=?`,
      )
      .bind(
        this.context.ownerId,
        token.job_id,
        token.fencing_token,
        this.context.actorId,
        this.context.credentialHash!,
      )
      .first<{ outcome_json: string; candidate_hash: string }>();
    if (replay) {
      const outcome = JSON.parse(replay.outcome_json) as Record<
        string,
        unknown
      >;
      if (
        (await sha256(replay.outcome_json)) !== replay.candidate_hash ||
        outcome.source_artifact_id !== sourceArtifactId ||
        outcome.segment_map_artifact_id !== manifestArtifactId
      )
        throw new Error('IDEMPOTENCY_CONFLICT');
      return { accepted: true, active: false, duplicate: true };
    }
    const { snapshot, run_id } = await this.input(token, now);
    const repository = new ArtifactRepository(this.db, this.context);
    const corrected = await repository.get(
      sourceArtifactId,
      token,
      'NORMALIZE',
      now,
    );
    const manifest = await repository.get(
      manifestArtifactId,
      token,
      'NORMALIZE',
      now,
    );
    for (const artifact of [corrected, manifest]) {
      const provenance = JSON.parse(artifact.provenance_json) as Record<
        string,
        unknown
      >;
      if (
        artifact.item_id !== snapshot.item_id ||
        artifact.state !== 'VERIFIED' ||
        artifact.producer_version !== 'owner-source-correction:1' ||
        artifact.original_ref !== snapshot.original_ref ||
        provenance.correction_job_id !== token.job_id ||
        provenance.original_hash !== snapshot.original_hash ||
        provenance.authored_by !== snapshot.authored_by
      )
        throw new Error('SOURCE_CORRECTION_ARTIFACT_MISMATCH');
    }
    if (
      corrected.kind !== 'NORMALIZED' ||
      manifest.kind !== 'SEGMENT_MAP' ||
      corrected.content_hash === snapshot.original_hash
    )
      throw new Error('SOURCE_CORRECTION_ARTIFACT_MISMATCH');
    const outcome = {
      version: 'corrected-source:1',
      kind: 'CORRECTED_SOURCE',
      item_id: snapshot.item_id,
      original_ref: snapshot.original_ref,
      original_hash: snapshot.original_hash,
      source_artifact_id: sourceArtifactId,
      source_hash: corrected.content_hash,
      segment_map_artifact_id: manifestArtifactId,
      manifest_hash: manifest.content_hash,
      language_code: snapshot.language_code,
      authored_by: snapshot.authored_by,
      reason: snapshot.reason,
      correction_job_id: token.job_id,
    };
    return new RunRepository(this.db, this.context).complete(
      token,
      'NORMALIZE',
      run_id,
      await sha256(JSON.stringify(outcome)),
      outcome,
      null,
      now,
    );
  }
}
