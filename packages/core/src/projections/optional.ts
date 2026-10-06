import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { ArtifactRepository } from '../artifacts/store.js';
import { sha256 } from '../auth/crypto.js';
import type { TranslationPlan } from '../ai/tasks/translation.js';
import type { HistoryPlan } from '../ai/tasks/history.js';
export class OptionalResultProjection {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async page(runId: string, start: number) {
    this.context.requireOwner();
    const row = await this.db
      .prepare(
        `SELECT x.*,r.input_snapshot_json,r.outcome_json,r.candidate_hash FROM optional_ai_results x JOIN analysis_runs r ON r.owner_id=x.owner_id AND r.run_id=x.run_id WHERE x.owner_id=? AND x.run_id=? AND r.state='ACCEPTED'`,
      )
      .bind(this.context.ownerId, runId)
      .first<{
        task_type: 'TRANSLATE' | 'HISTORICAL_COMPARE';
        item_id: string;
        canonical_artifact_id: string;
        canonical_hash: string;
        plan_hash: string;
        source_artifact_id: string | null;
        input_snapshot_json: string;
        outcome_json: string;
        candidate_hash: string;
      }>();
    if (!row || (await sha256(row.outcome_json)) !== row.candidate_hash)
      throw new Error('NOT_FOUND');
    const plan = JSON.parse(row.input_snapshot_json) as
      TranslationPlan | HistoryPlan;
    if (
      plan.hash !== row.plan_hash ||
      (await sha256(JSON.stringify(plan.snapshot))) !== plan.hash
    )
      throw new Error('OPTIONAL_SNAPSHOT_MISMATCH');
    const page = await new ArtifactRepository(
      this.db,
      this.context,
    ).readOwnerPage(row.canonical_artifact_id, start);
    if (
      page.artifact.content_hash !== row.canonical_hash ||
      page.artifact.item_id !== row.item_id ||
      page.artifact.kind !== 'ANALYSIS_CANDIDATE'
    )
      throw new Error('OPTIONAL_SNAPSHOT_MISMATCH');
    const context =
      'segments' in plan.snapshot
        ? {
            task: 'TRANSLATE' as const,
            source_artifact_id: row.source_artifact_id,
            segments: plan.snapshot.segments.map(
              ({
                source_segment_id,
                start_ms,
                end_ms,
                timestamp_precision,
              }) => ({
                source_segment_id,
                start_ms,
                end_ms,
                timestamp_precision,
              }),
            ),
          }
        : {
            task: 'HISTORICAL_COMPARE' as const,
            cut: plan.snapshot.cut,
            observations: [
              ...plan.snapshot.current.observations,
              ...plan.snapshot.prior.observations,
            ].map((o) => ({
              observation_id: o.row.observation_id,
              content_pl: o.row.content_pl,
              item_id: o.item_id,
              run_id: o.run_id,
              evidence: o.evidence,
            })),
          };
    return {
      run_id: runId,
      item_id: row.item_id,
      context,
      descriptor: {
        artifact_id: page.artifact.artifact_id,
        content_hash: page.artifact.content_hash!,
        byte_size: page.artifact.byte_size,
        chunk_count: page.artifact.chunk_count,
        schema_version: page.artifact.schema_version,
      },
      chunks: page.chunks.map(
        ({ chunk_index, byte_start, byte_size, byte_hash, body_base64 }) => ({
          chunk_index,
          byte_start,
          byte_size,
          byte_hash,
          body_base64,
        }),
      ),
      next_index: page.next_index,
    };
  }
}
