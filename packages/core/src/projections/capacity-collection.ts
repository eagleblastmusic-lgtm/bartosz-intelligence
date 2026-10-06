import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { decodeCursor, encodeCursor, pageLimit } from '../db/cursor.js';

// Measurement-only metadata. No source/canonical text, prompts or credentials.
export class CapacityCollection {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
    if (context.kind === 'owner') context.requireOwner();
    else context.requireTask('PROJECT');
  }
  async page(limit: number, secret: string, now: Date, cursorValue?: string) {
    pageLimit(limit);
    const cursor = cursorValue
      ? await decodeCursor(
          cursorValue,
          this.context.ownerId,
          'capacity-collection:1',
          secret,
        )
      : null;
    const result = await this.db.batch([
      this.db
        .prepare(
          'SELECT COALESCE(MAX(seq),0) cut_seq FROM change_log WHERE owner_id=?',
        )
        .bind(this.context.ownerId),
      this.db
        .prepare(
          `SELECT i.item_id,i.source_id,i.external_id,i.published_at,i.publication_provenance,i.discovered_at,i.availability,
        j.job_id,j.state job_state,j.reason_code,j.arrival_origin_at,j.origin_kind,j.attempt_count,j.due_at,j.input_revision,j.profile_revision,j.prompt_snapshot_id,
        (SELECT MIN(a.started_at) FROM job_attempts a JOIN jobs q ON q.owner_id=a.owner_id AND q.job_id=a.job_id WHERE q.owner_id=i.owner_id AND q.item_id=i.item_id AND q.task_type='ANALYZE' AND json_extract(q.payload_json,'$.snapshot.settings.mode')='PRODUCTION' AND json_type(q.payload_json,'$.snapshot.chunk') IS NULL) analysis_started_at,
        ir.accepted_at accepted_complete_at,ir.run_id accepted_effect_id,
        sr.run_id source_run_id,sr.accepted_at source_accepted_at,sr.candidate_hash source_outcome_hash,
        json_extract(sr.outcome_json,'$.source_artifact_id') source_artifact_id,json_extract(sr.outcome_json,'$.source_hash') source_hash,
        json_extract(sr.outcome_json,'$.authority.language_code') source_language,json_extract(sr.outcome_json,'$.authority.authority_confidence') source_authority,
        ar.byte_size source_bytes
        FROM items i LEFT JOIN jobs j ON j.owner_id=i.owner_id AND j.job_id=(SELECT q.job_id FROM jobs q WHERE q.owner_id=i.owner_id AND q.item_id=i.item_id AND q.task_type IN ('ANALYZE','FETCH_TRANSCRIPT') AND (q.task_type!='ANALYZE' OR json_extract(q.payload_json,'$.snapshot.settings.mode')='PRODUCTION') AND json_type(q.payload_json,'$.snapshot.chunk') IS NULL ORDER BY q.created_at DESC,q.job_id DESC LIMIT 1)
        LEFT JOIN analysis_runs ir ON ir.owner_id=i.owner_id AND ir.run_id=(SELECT r.run_id FROM analysis_runs r JOIN jobs q ON q.owner_id=r.owner_id AND q.job_id=r.job_id WHERE r.owner_id=i.owner_id AND r.item_id=i.item_id AND r.state='ACCEPTED' AND q.task_type='ANALYZE' AND json_extract(r.outcome_json,'$.version')='intelligence-accepted:1' AND json_extract(r.outcome_json,'$.view.coverage_complete')=1 AND json_extract(r.outcome_json,'$.view.status')='OK' ORDER BY r.accepted_at,r.run_id LIMIT 1)
        LEFT JOIN analysis_runs sr ON sr.owner_id=i.owner_id AND sr.run_id=(SELECT r.run_id FROM analysis_runs r JOIN jobs q ON q.owner_id=r.owner_id AND q.job_id=r.job_id WHERE r.owner_id=i.owner_id AND r.item_id=i.item_id AND r.state='ACCEPTED' AND q.task_type='FETCH_TRANSCRIPT' AND json_extract(r.outcome_json,'$.version')='transcript-source:1' AND (ir.run_id IS NULL OR json_extract(r.outcome_json,'$.source_artifact_id')=json_extract(ir.outcome_json,'$.source_artifact_id')) ORDER BY r.created_at DESC,r.run_id DESC LIMIT 1)
        LEFT JOIN artifacts ar ON ar.owner_id=i.owner_id AND ar.item_id=i.item_id AND ar.artifact_id=json_extract(sr.outcome_json,'$.source_artifact_id') AND ar.state='VERIFIED' AND ar.kind='SOURCE_ORIGINAL'
        WHERE i.owner_id=? AND (? IS NULL OR i.item_id>?) ORDER BY i.item_id LIMIT ?`,
        )
        .bind(
          this.context.ownerId,
          cursor?.id ?? null,
          cursor?.id ?? null,
          limit + 1,
        ),
    ]);
    const seq = String((result[0]!.results![0] as { cut_seq: number }).cut_seq);
    if (cursor && cursor.snapshot !== seq)
      throw new Error('READ_SNAPSHOT_CHANGED');
    const rows = result[1]!.results! as Record<string, unknown>[];
    const more = rows.length > limit;
    const cases = rows.slice(0, limit);
    const sampledAt = cursor?.time ?? now.toISOString();
    return {
      version: 'capacity-collection:1',
      sampled_at: sampledAt,
      cut_seq: seq,
      cases,
      eligibility_status: 'UNCLASSIFIED',
      next_cursor: more
        ? await encodeCursor(
            {
              owner: this.context.ownerId,
              kind: 'capacity-collection:1',
              snapshot: seq,
              time: sampledAt,
              id: String(cases.at(-1)!.item_id),
            },
            secret,
          )
        : null,
    };
  }
}
