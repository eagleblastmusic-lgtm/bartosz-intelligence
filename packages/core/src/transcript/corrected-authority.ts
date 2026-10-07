import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
/** A correction is authority only for the explicitly selected immutable revision. */
export async function acceptedCorrectedSource(
  db: Database,
  context: AccessContext,
  runId: string,
) {
  assertContext(context);
  if (context.kind === 'worker') context.requireTask('ANALYZE');
  else context.requireOwner();
  const row = await db
    .prepare(
      "SELECT r.item_id,r.outcome_json,r.candidate_hash,j.job_id FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.run_id=? AND r.state='ACCEPTED' AND j.task_type='NORMALIZE' AND j.profile_revision='owner-source-correction:1' AND j.state='SUCCEEDED'",
    )
    .bind(context.ownerId, runId)
    .first<{
      item_id: string;
      outcome_json: string;
      candidate_hash: string;
      job_id: string;
    }>();
  if (!row || (await sha256(row.outcome_json)) !== row.candidate_hash)
    throw new Error('ANALYSIS_SOURCE_NOT_ACCEPTED');
  const value = JSON.parse(row.outcome_json) as {
    version: string;
    kind: string;
    item_id: string;
    original_ref: string;
    original_hash: string;
    source_artifact_id: string;
    source_hash: string;
    segment_map_artifact_id: string;
    manifest_hash: string;
    language_code: string;
    authored_by: string;
    correction_job_id: string;
  };
  if (
    value.version !== 'corrected-source:1' ||
    value.kind !== 'CORRECTED_SOURCE' ||
    value.item_id !== row.item_id ||
    value.authored_by !== context.ownerId ||
    value.correction_job_id !== row.job_id
  )
    throw new Error('ANALYSIS_SOURCE_AUTHORITY_REQUIRED');
  const pair = await db
    .prepare(
      `SELECT 1 FROM artifacts a JOIN artifacts m ON m.owner_id=a.owner_id AND m.item_id=a.item_id AND m.original_ref=a.original_ref JOIN artifacts o ON o.owner_id=a.owner_id AND o.item_id=a.item_id AND o.artifact_id=a.original_ref
    WHERE a.owner_id=? AND a.item_id=? AND a.artifact_id=? AND a.kind='NORMALIZED' AND a.state='VERIFIED' AND a.content_hash=? AND a.producer_version='owner-source-correction:1' AND a.original_ref=?
    AND m.artifact_id=? AND m.kind='SEGMENT_MAP' AND m.state='VERIFIED' AND m.content_hash=? AND m.producer_version=a.producer_version AND o.kind='SOURCE_ORIGINAL' AND o.state='VERIFIED' AND o.content_hash=?
    AND json_extract(a.provenance_json,'$.kind')='CORRECTED_SOURCE' AND json_extract(a.provenance_json,'$.correction_job_id')=? AND json_extract(m.provenance_json,'$.correction_job_id')=? AND json_extract(a.provenance_json,'$.original_hash')=o.content_hash AND json_extract(m.provenance_json,'$.original_hash')=o.content_hash AND json_extract(a.provenance_json,'$.authored_by')=? AND json_extract(m.provenance_json,'$.authored_by')=?
    AND EXISTS(SELECT 1 FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=o.owner_id AND r.item_id=o.item_id AND r.state='ACCEPTED' AND j.state='SUCCEEDED' AND j.task_type='FETCH_TRANSCRIPT' AND json_extract(r.outcome_json,'$.source_artifact_id')=o.artifact_id AND json_extract(r.outcome_json,'$.source_hash')=o.content_hash AND json_extract(r.outcome_json,'$.authority.authority_confidence')='CONFIRMED' AND json_extract(r.outcome_json,'$.authority.language_code')=?)`,
    )
    .bind(
      context.ownerId,
      row.item_id,
      value.source_artifact_id,
      value.source_hash,
      value.original_ref,
      value.segment_map_artifact_id,
      value.manifest_hash,
      value.original_hash,
      row.job_id,
      row.job_id,
      context.ownerId,
      context.ownerId,
      value.language_code,
    )
    .first();
  if (!pair) throw new Error('ANALYSIS_SOURCE_ARTIFACT_MISMATCH');
  return {
    run_id: runId,
    item_id: row.item_id,
    source_artifact_id: value.source_artifact_id,
    segment_map_artifact_id: value.segment_map_artifact_id,
    source_hash: value.source_hash,
    manifest_hash: value.manifest_hash,
    language_code: value.language_code,
    correction: {
      original_ref: value.original_ref,
      original_hash: value.original_hash,
      producer_version: 'owner-source-correction:1' as const,
    },
  };
}
