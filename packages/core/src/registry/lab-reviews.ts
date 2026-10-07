import { sha256 } from '../auth/crypto.js';
import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { ArtifactRepository } from '../artifacts/store.js';
import type { AnalysisJobSnapshot } from '../ai/jobs.js';
import type { OptionalTaskSnapshot } from '../ai/tasks/jobs.js';
export const labCriticalErrors = [
  'NEGATION_CHANGED',
  'NUMBER_CHANGED',
  'FABRICATED_FACT',
  'ASR_GUESSED',
  'MISSING_SEGMENT',
  'FABRICATED_TIMESTAMP',
  'SEVERE_HALLUCINATION',
  'UNSUPPORTED_CLAIM',
  'INVALID_EVIDENCE',
] as const;
export interface LabHumanReview {
  reviewer_id: string;
  role: 'PRIMARY' | 'INDEPENDENT';
  blind_label: string;
  scores: [number | null, number | null, number | null, number | null];
  supported: boolean | null;
  important_claims_complete: boolean | null;
  evidence_valid: boolean | null;
  critical_errors: (typeof labCriticalErrors)[number][] | null;
  notes: string;
}
/** Owner-entered human labels are immutable evidence, never a provider approval. */
export class LabReviews {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  private async run(experimentHash: string, runId: string) {
    this.context.requireOwner();
    if (
      !/^[a-f0-9]{64}$/.test(experimentHash) ||
      typeof runId !== 'string' ||
      !runId ||
      runId.length > 128
    )
      throw new Error('INVALID_LAB_RUN');
    const row = await this.db
      .prepare(
        "SELECT r.run_id,r.item_id,r.outcome_json,r.candidate_hash,j.payload_json,j.state,j.reason_code FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.run_id=? AND r.state='CANDIDATE' AND j.state IN ('SUCCEEDED','FAILED') AND json_extract(j.payload_json,'$.snapshot.workload')='PROMPT_LAB' AND json_extract(j.payload_json,'$.snapshot.lab_experiment_hash')=? AND json_extract(j.payload_json,'$.snapshot.settings.mode')='QUALITY_TEST'",
      )
      .bind(this.context.ownerId, runId, experimentHash)
      .first<{
        run_id: string;
        item_id: string;
        outcome_json: string;
        candidate_hash: string;
        payload_json: string;
        state: string;
        reason_code: string;
      }>();
    if (!row) throw new Error('NOT_FOUND');
    if (
      !row.candidate_hash ||
      (await sha256(row.outcome_json)) !== row.candidate_hash
    )
      throw new Error('REGISTRY_HASH_MISMATCH');
    const snapshot = (
      JSON.parse(row.payload_json) as {
        snapshot: AnalysisJobSnapshot | OptionalTaskSnapshot;
      }
    ).snapshot;
    return {
      ...row,
      snapshot,
      outcome: JSON.parse(row.outcome_json) as {
        validation?: {
          canonical_artifact_id: string | null;
          canonical_hash: string | null;
        };
        mapped?: { canonical: Record<string, unknown>; canonical_hash: string };
        reason?: string;
      },
    };
  }
  async inspect(
    hash: string,
    runId: string,
    section: 'CANONICAL' | 'SOURCE' = 'CANONICAL',
    offset = 0,
  ) {
    const run = await this.run(hash, runId);
    if (
      !['CANONICAL', 'SOURCE'].includes(section) ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error('INVALID_LAB_INSPECTION');
    const repo = new ArtifactRepository(this.db, this.context);
    let text = '',
      contentHash: string | null = null,
      format = 'JSON';
    if (section === 'CANONICAL') {
      if (run.outcome.validation?.canonical_artifact_id) {
        const artifact = await repo.readVerifiedText(
          run.outcome.validation.canonical_artifact_id,
          8 * 1024 * 1024,
        );
        if (
          artifact.artifact.content_hash !==
            run.outcome.validation.canonical_hash ||
          artifact.artifact.item_id !== run.item_id
        )
          throw new Error('REGISTRY_HASH_MISMATCH');
        text = artifact.text;
        contentHash = artifact.artifact.content_hash;
      } else if (run.outcome.mapped) {
        text = JSON.stringify(run.outcome.mapped.canonical);
        contentHash = await sha256(text);
        if (contentHash !== run.outcome.mapped.canonical_hash)
          throw new Error('REGISTRY_HASH_MISMATCH');
      }
    } else if ('source' in run.snapshot) {
      const artifact = await repo.readVerifiedText(
        run.snapshot.source.source_artifact_id,
        8 * 1024 * 1024,
      );
      if (
        artifact.artifact.content_hash !== run.snapshot.source.source_hash ||
        artifact.artifact.item_id !== run.item_id
      )
        throw new Error('REGISTRY_HASH_MISMATCH');
      text = artifact.text;
      contentHash = artifact.artifact.content_hash;
      format = 'ORIGINAL_TEXT';
    } else {
      text = JSON.stringify(run.snapshot.plan.snapshot);
      contentHash = await sha256(text);
      if (contentHash !== run.snapshot.plan.hash)
        throw new Error('REGISTRY_HASH_MISMATCH');
      format = 'PINNED_SOURCE_PLAN_JSON';
    }
    if (offset > text.length) throw new Error('INVALID_LAB_INSPECTION');
    const end = Math.min(offset + 16384, text.length);
    return {
      run_id: runId,
      candidate_hash: run.candidate_hash,
      section,
      format,
      content_hash: contentHash,
      text: text.slice(offset, end),
      offset,
      end,
      total_code_units: text.length,
      next_offset: end < text.length ? end : null,
      job_state: run.state,
      reason_code: run.reason_code,
      semantic_verification: 'NOT_ASSERTED',
      provider: run.snapshot.profile.provider_id,
      model: run.snapshot.profile.model,
      prompt_hash: run.snapshot.prompt.prompt_hash,
      selection_effect: 'NONE',
    };
  }
  async history(hash: string, runId: string) {
    const run = await this.run(hash, runId);
    const rows = await this.db
      .prepare(
        "SELECT config_id,revision,payload_json,content_hash FROM config_versions WHERE owner_id=? AND json_extract(payload_json,'$.version')='lab-human-review:1' AND json_extract(payload_json,'$.experiment_hash')=? AND json_extract(payload_json,'$.run_id')=? ORDER BY created_at DESC,config_id,revision DESC LIMIT 51",
      )
      .bind(this.context.ownerId, hash, runId)
      .all<{
        config_id: string;
        revision: number;
        payload_json: string;
        content_hash: string;
      }>();
    const reviews = [];
    for (const row of rows.results.slice(0, 50)) {
      if ((await sha256(row.payload_json)) !== row.content_hash)
        throw new Error('REGISTRY_HASH_MISMATCH');
      const value = JSON.parse(row.payload_json) as {
        review: LabHumanReview;
        candidate_hash: string;
        created_at: string;
      };
      if (value.candidate_hash !== run.candidate_hash)
        throw new Error('REGISTRY_HASH_MISMATCH');
      reviews.push({
        revision: row.revision,
        hash: row.content_hash,
        ...value,
      });
    }
    return {
      reviews,
      truncated: rows.results.length > 50,
      quality_approval: 'NOT_GRANTED',
    };
  }
  async record(
    hash: string,
    runId: string,
    review: LabHumanReview,
    expectedRevision: number,
    now: Date,
  ) {
    const run = await this.run(hash, runId);
    if (
      !review ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(review.reviewer_id) ||
      !['PRIMARY', 'INDEPENDENT'].includes(review.role) ||
      typeof review.blind_label !== 'string' ||
      !review.blind_label.trim() ||
      review.blind_label.length > 80 ||
      ['A', 'B'].includes(review.blind_label) ||
      !Array.isArray(review.scores) ||
      review.scores.length !== 4 ||
      review.scores.some(
        (value) =>
          value !== null &&
          (!Number.isInteger(value) || value < 0 || value > 4),
      ) ||
      [
        review.supported,
        review.important_claims_complete,
        review.evidence_valid,
      ].some((value) => value !== null && typeof value !== 'boolean') ||
      (review.critical_errors !== null &&
        (!Array.isArray(review.critical_errors) ||
          new Set(review.critical_errors).size !==
            review.critical_errors.length ||
          review.critical_errors.some(
            (value) => !labCriticalErrors.includes(value),
          ))) ||
      typeof review.notes !== 'string' ||
      review.notes.length > 8000 ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      !Number.isFinite(now.getTime())
    )
      throw new Error('INVALID_LAB_HUMAN_REVIEW');
    const normalized = {
      reviewer_id: review.reviewer_id,
      role: review.role,
      blind_label: review.blind_label.trim(),
      scores: review.scores,
      supported: review.supported,
      important_claims_complete: review.important_claims_complete,
      evidence_valid: review.evidence_valid,
      critical_errors: review.critical_errors,
      notes: review.notes.trim(),
    };
    const key =
        'lab-review-' +
        (await sha256(hash + ':' + runId + ':' + review.reviewer_id)),
      revision = expectedRevision + 1;
    const prior = await this.db
      .prepare(
        'SELECT revision,payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id=? ORDER BY revision DESC LIMIT 1',
      )
      .bind(this.context.ownerId, key)
      .first<{
        revision: number;
        payload_json: string;
        content_hash: string;
      }>();
    if (prior) {
      if ((await sha256(prior.payload_json)) !== prior.content_hash)
        throw new Error('REGISTRY_HASH_MISMATCH');
      if (JSON.parse(prior.payload_json).candidate_hash !== run.candidate_hash)
        throw new Error('REGISTRY_HASH_MISMATCH');
      if (JSON.parse(prior.payload_json).review.role !== review.role)
        throw new Error('INVALID_LAB_REVIEW_ROLE');
      if (
        prior.revision === revision &&
        JSON.stringify(JSON.parse(prior.payload_json).review) ===
          JSON.stringify(normalized)
      )
        return {
          revision,
          hash: prior.content_hash,
          quality_approval: 'NOT_GRANTED',
        };
    }
    const serialized = JSON.stringify({
        version: 'lab-human-review:1',
        experiment_hash: hash,
        run_id: runId,
        candidate_hash: run.candidate_hash,
        review: normalized,
        entered_by: this.context.actorId,
        created_at: now.toISOString(),
        quality_approval: 'NOT_GRANTED',
      }),
      contentHash = await sha256(serialized);
    const writes = await this.db.batch([
      this.db
        .prepare(
          'INSERT INTO config_versions SELECT ?,?,?,?,?,? WHERE COALESCE((SELECT MAX(revision) FROM config_versions WHERE owner_id=? AND config_id=?),0)=? ON CONFLICT DO NOTHING',
        )
        .bind(
          key,
          this.context.ownerId,
          revision,
          serialized,
          contentHash,
          now.toISOString(),
          this.context.ownerId,
          key,
          expectedRevision,
        ),
      this.db
        .prepare(
          "INSERT INTO audit_events SELECT ?,?,?,'LAB_HUMAN_REVIEW_RECORDED',?,?,? WHERE changes()=1 ON CONFLICT DO NOTHING",
        )
        .bind(
          key + '-' + revision,
          this.context.ownerId,
          this.context.actorId,
          runId,
          contentHash,
          now.toISOString(),
        ),
    ]);
    if (writes[0]?.meta.changes !== 1) throw new Error('REVISION_CONFLICT');
    return { revision, hash: contentHash, quality_approval: 'NOT_GRANTED' };
  }
}
