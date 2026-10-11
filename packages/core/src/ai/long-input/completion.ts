import {
  assertContext,
  type AccessContext,
  type Database,
} from '../../db/boundary.js';
import {
  ArtifactRepository,
  splitArtifactText,
} from '../../artifacts/store.js';
import { sha256 } from '../../auth/crypto.js';
import { JobStore } from '../../jobs/store.js';
import { RunRepository } from '../../jobs/acceptance.js';
import { AnalysisJobs, type AnalysisJobSnapshot } from '../jobs.js';
import { finalizeCandidateRun } from '../candidate-finalization.js';
import { IntelligenceLedger } from '../enrichment/ledger.js';
import { enrichEconomy, enrichSemantic } from '../enrichment/canonical.js';
import { mergeChunkOutputs } from './merge.js';
import { LongInputJobs } from './jobs.js';
import type { ChunkPlan } from './plan.js';
import type { LeaseToken } from '../../../../contracts/src/jobs.js';
import type { normalizeTranscript } from '../../transcript/normalize.js';
import { acceptedView } from '../../projections/accepted-view.js';
import { assessAnalysisQuality } from '../quality.js';

export class LongInputCompletion {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async complete(token: LeaseToken, now: Date, secret: string) {
    this.context.requireTask('ANALYZE');
    if (token.lease_owner !== this.context.actorId)
      throw new Error('STALE_FENCE');
    const duplicate = await this.db
      .prepare(
        `SELECT r.run_id,r.state,r.candidate_hash,r.outcome_json FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id JOIN job_attempts a ON a.owner_id=j.owner_id AND a.job_id=j.job_id JOIN worker_identities w ON w.owner_id=a.owner_id AND w.worker_id=a.executor_id WHERE r.owner_id=? AND j.job_id=? AND j.state='SUCCEEDED' AND j.result_candidate_id=r.run_id AND a.fencing_token=? AND a.candidate_hash=r.candidate_hash AND w.worker_id=? AND w.credential_hash=? AND w.revoked_at IS NULL`,
      )
      .bind(
        this.context.ownerId,
        token.job_id,
        token.fencing_token,
        this.context.actorId,
        this.context.credentialHash!,
      )
      .first<{
        run_id: string;
        state: string;
        candidate_hash: string;
        outcome_json: string;
      }>();
    if (duplicate) {
      const outcome = JSON.parse(duplicate.outcome_json) as {
        kind: string;
        chunk_coverage: { complete: boolean };
      };
      if (
        (await sha256(duplicate.outcome_json)) !== duplicate.candidate_hash ||
        outcome.kind !== 'CHUNK_MERGE' ||
        !outcome.chunk_coverage.complete
      )
        throw new Error('INVALID_COMPLETION');
      return {
        accepted: duplicate.state === 'ACCEPTED',
        duplicate: true,
        state: 'SUCCEEDED',
        run_id: duplicate.run_id,
      };
    }
    const started = Date.now(),
      current = () => new Date(now.getTime() + Date.now() - started),
      jobs = new AnalysisJobs(this.db, this.context),
      prepared = await jobs.prepareRun(token, current()),
      snapshot = prepared.snapshot;
    if (snapshot.chunk) throw new Error('CHUNK_NOT_PARENT');
    const status = await new LongInputJobs(this.db, this.context).status(
      token.job_id,
    );
    if (status.parent_snapshot_hash !== prepared.snapshot_hash)
      throw new Error('CHUNK_CONTEXT_MISMATCH');
    if (!status.complete) {
      if (status.parts.some((part) => part.state === 'MISSING'))
        return {
          accepted: false,
          duplicate: false,
          state: 'RUNNING',
          preparation_required: true,
          plan_artifact_id: status.plan_artifact_id,
          plan_hash: status.plan_hash,
        };
      await new JobStore(this.db, this.context).disposition(
        token,
        'ANALYZE',
        'DEFERRED',
        'CHUNKS_PENDING',
        new Date(current().getTime() + 60000).toISOString(),
        current(),
      );
      return {
        accepted: false,
        duplicate: false,
        state: 'DEFERRED',
        missing: status.missing,
      };
    }
    const repo = new ArtifactRepository(this.db, this.context),
      planFile = await repo.readVerifiedText(
        status.plan_artifact_id,
        32 * 1024 * 1024,
        token,
        'ANALYZE',
        current(),
      ),
      source = await repo.readVerifiedText(
        snapshot.source.source_artifact_id,
        4 * 1024 * 1024,
        token,
        'ANALYZE',
        current(),
      ),
      map = await repo.readVerifiedText(
        snapshot.source.segment_map_artifact_id,
        32 * 1024 * 1024,
        token,
        'ANALYZE',
        current(),
      );
    if (
      planFile.artifact.content_hash !== status.plan_hash ||
      source.artifact.content_hash !== snapshot.source.source_hash ||
      map.artifact.content_hash !== snapshot.source.manifest_hash
    )
      throw new Error('CHUNK_SOURCE_MISMATCH');
    const manifest = JSON.parse(map.text) as Awaited<
        ReturnType<typeof normalizeTranscript>
      >['manifest'],
      outputs: { chunk_index: number; raw: string; completion: 'OK' }[] = [],
      receipts: {
        chunk_index: number;
        run_id: string;
        response_hash: string;
        canonical_hash: string;
      }[] = [];
    let total = 0;
    for (const part of status.parts) {
      const row = await this.db
        .prepare(
          `SELECT j.payload_json,j.profile_revision,r.run_id,r.outcome_json,r.candidate_hash FROM jobs j JOIN analysis_runs r ON r.owner_id=j.owner_id AND r.job_id=j.job_id AND r.run_id=j.result_candidate_id WHERE j.owner_id=? AND j.job_id=? AND j.state='SUCCEEDED' AND j.reason_code='CHUNK_CANDIDATE_COMPLETE' AND r.state='CANDIDATE'`,
        )
        .bind(this.context.ownerId, part.job_id!)
        .first<{
          payload_json: string;
          profile_revision: string;
          run_id: string;
          outcome_json: string;
          candidate_hash: string;
        }>();
      if (!row || (await sha256(row.outcome_json)) !== row.candidate_hash)
        throw new Error('INVALID_CHUNK_CANDIDATE');
      const child = (
          JSON.parse(row.payload_json) as { snapshot: AnalysisJobSnapshot }
        ).snapshot,
        outcome = JSON.parse(row.outcome_json) as {
          version: string;
          reservation_id: string;
          validation: {
            status: string;
            response_artifact_id: string;
            canonical_hash: string;
            accepted: boolean;
            chunk: { plan_hash: string; chunk_index: number };
          };
        };
      if (
        (await sha256(JSON.stringify(child))) !== row.profile_revision ||
        child.chunk?.parent_job_id !== token.job_id ||
        child.chunk.parent_snapshot_hash !== prepared.snapshot_hash ||
        child.chunk.chunk_index !== part.chunk_index ||
        child.chunk.plan_hash !== status.plan_hash ||
        child.source.source_hash !== snapshot.source.source_hash ||
        child.prompt.prompt_hash !== snapshot.prompt.prompt_hash ||
        JSON.stringify(child.profile) !== JSON.stringify(snapshot.profile) ||
        outcome.version !== 'chunk-candidate:1' ||
        outcome.validation.status !== 'VALIDATED' ||
        outcome.validation.accepted !== false ||
        outcome.validation.chunk?.plan_hash !== status.plan_hash ||
        outcome.validation.chunk.chunk_index !== part.chunk_index
      )
        throw new Error('INVALID_CHUNK_CANDIDATE');
      const raw = await repo.readVerifiedText(
        outcome.validation.response_artifact_id,
        2 * 1024 * 1024,
        token,
        'ANALYZE',
        current(),
      );
      const provenance = JSON.parse(raw.artifact.provenance_json) as {
        reservation_id: string;
        raw_output_present: boolean;
        response: { request_id: string; status: string; actual_model: string };
      };
      if (
        raw.artifact.kind !== 'ANALYSIS_CANDIDATE' ||
        provenance.reservation_id !== outcome.reservation_id ||
        !provenance.raw_output_present ||
        provenance.response.request_id !== row.run_id ||
        provenance.response.status !== 'OK' ||
        provenance.response.actual_model !== snapshot.profile.model
      )
        throw new Error('INVALID_CHUNK_CANDIDATE');
      total += raw.artifact.byte_size;
      if (total > 8 * 1024 * 1024) throw new Error('CHUNK_MERGE_INPUT_BUDGET');
      outputs.push({
        chunk_index: part.chunk_index,
        raw: raw.text,
        completion: 'OK',
      });
      receipts.push({
        chunk_index: part.chunk_index,
        run_id: row.run_id,
        response_hash: raw.artifact.content_hash,
        canonical_hash: outcome.validation.canonical_hash,
      });
    }
    const merged = await mergeChunkOutputs({
      semantic_profile: snapshot.semantic_profile?.compiled,
      plan: JSON.parse(planFile.text) as ChunkPlan,
      plan_hash: status.plan_hash,
      manifest,
      manifest_hash: snapshot.source.manifest_hash,
      outputs,
    });
    if (!merged.coverage.complete || merged.status !== 'COMPLETE')
      throw new Error('INCOMPLETE_CHUNK_COVERAGE');
    const quality = assessAnalysisQuality(
      merged.wire as Parameters<typeof assessAnalysisQuality>[0],
      manifest.anchors,
      {
        radio: snapshot.prompt.quality_policy?.version === 'analysis-quality:3',
      },
    );
    if (quality.status === 'REVIEW_REQUIRED') {
      await new JobStore(this.db, this.context).disposition(
        token,
        'ANALYZE',
        'BLOCKED',
        'AI_OUTPUT_REVIEW_REQUIRED',
        current().toISOString(),
        current(),
      );
      return {
        accepted: false,
        duplicate: false,
        state: 'BLOCKED',
        reason: 'AI_OUTPUT_REVIEW_REQUIRED',
        quality,
      };
    }
    const item = await this.db
      .prepare('SELECT canonical_url FROM items WHERE owner_id=? AND item_id=?')
      .bind(this.context.ownerId, snapshot.source.item_id)
      .first<{ canonical_url: string }>();
    const enrichmentInput = {
      raw: JSON.stringify(merged.wire),
      completion: 'OK' as const,
      run_id: prepared.run_id,
      item_id: snapshot.source.item_id,
      profile_id:
        snapshot.semantic_profile?.profile_id ?? snapshot.profile.profile_id,
      profile_revision: prepared.snapshot_hash,
      source: {
        owner_id: this.context.ownerId,
        source_artifact_id: snapshot.source.source_artifact_id,
        source_language: snapshot.source.language_code,
        source_text: source.text,
        manifest,
        manifest_hash: snapshot.source.manifest_hash,
        video_url: item?.canonical_url ?? null,
      },
      approved_aliases: await new IntelligenceLedger(
        this.db,
        this.context,
      ).aliases(token, current()),
    };
    const enriched = snapshot.semantic_profile
      ? await enrichSemantic(
          enrichmentInput,
          snapshot.semantic_profile.compiled,
        )
      : await enrichEconomy(enrichmentInput);
    await jobs.load(token, current());
    const canonicalText = JSON.stringify(enriched.canonical),
      contextHash = await sha256(
        JSON.stringify({
          plan_hash: status.plan_hash,
          parent_snapshot_hash: prepared.snapshot_hash,
          receipts,
          coverage: merged.coverage,
          relational_coverage: merged.relational_coverage,
          sectional_summaries: merged.sectional_summaries,
        }),
      );
    const persist = async (
      text: string,
      hash: string,
      schema: string,
      producer: string,
    ) => {
      const pieces = splitArtifactText(text);
      const artifact = await repo.begin(
        {
          item_id: snapshot.source.item_id,
          kind: 'ANALYSIS_CANDIDATE',
          content_hash: hash,
          byte_size: new TextEncoder().encode(text).length,
          chunk_count: pieces.length,
          schema_version: schema,
          producer_version: producer + prepared.run_id,
          original_ref: snapshot.source.source_artifact_id,
          provenance: {
            context_hash: contextHash,
            plan_hash: status.plan_hash,
            source_hash: snapshot.source.source_hash,
            wire_schema_hash: snapshot.prompt.wire.hash,
            semantic_verification: 'NOT_ASSERTED',
          },
        },
        token,
        'ANALYZE',
        current(),
      );
      if (artifact.state !== 'VERIFIED') {
        let offset = 0;
        for (const [index, piece] of pieces.entries()) {
          await repo.writeChunk(
            artifact.artifact_id,
            index,
            offset,
            piece,
            token,
            'ANALYZE',
            current(),
          );
          offset += piece.length;
        }
        let proof: string | undefined;
        for (;;) {
          const step = await repo.verifyStep(
            artifact.artifact_id,
            token,
            'ANALYZE',
            current(),
            secret,
            proof,
          );
          if (step.complete) break;
          proof = step.proof ?? undefined;
        }
      }
      return artifact;
    };
    const artifact = await persist(
      canonicalText,
      enriched.canonical_hash,
      'intelligence-canonical:1.2',
      'core-chunk-merge:1:',
    );
    const mergedWireText = JSON.stringify(merged.wire),
      mergedWireHash = await sha256(mergedWireText);
    const mergedWireArtifact = await persist(
      mergedWireText,
      mergedWireHash,
      'semantic-wire-merge:1',
      'core-chunk-wire:1:',
    );
    const outcome = {
      version:
        snapshot.settings.mode === 'PRODUCTION'
          ? 'intelligence-accepted:1'
          : 'quality-candidate:1',
      kind: 'CHUNK_MERGE',
      view: acceptedView(
        enriched.canonical,
        snapshot.semantic_profile?.compiled.config.mode !== 'ECONOMY' &&
          snapshot.semantic_profile
          ? merged.relational_coverage
          : undefined,
      ),
      run_id: prepared.run_id,
      source_run_id: snapshot.source.run_id,
      source_artifact_id: snapshot.source.source_artifact_id,
      canonical_artifact_id: artifact.artifact_id,
      canonical_hash: enriched.canonical_hash,
      merged_wire_artifact_id: mergedWireArtifact.artifact_id,
      merged_wire_hash: mergedWireHash,
      context_hash: contextHash,
      quality_scope: snapshot.quality_scope,
      quality,
      child_receipts: receipts,
      chunk_coverage: merged.coverage,
      sectional_summaries: merged.sectional_summaries,
      additional_synthesis_requests: 0,
      semantic_verification: 'NOT_ASSERTED',
    };
    await jobs.load(token, current());
    if (snapshot.settings.mode === 'QUALITY_TEST')
      return finalizeCandidateRun(
        this.db,
        this.context,
        token,
        prepared.run_id,
        outcome,
        'QUALITY_TEST_COMPLETE',
        current(),
      );
    const effects = await new IntelligenceLedger(this.db, this.context).prepare(
        enriched,
        prepared.run_id,
        token,
        current(),
      ),
      selection = await this.db
        .prepare(
          'SELECT selection_revision FROM active_analysis_selections WHERE owner_id=? AND item_id=? AND requested_run_id=?',
        )
        .bind(this.context.ownerId, snapshot.source.item_id, prepared.run_id)
        .first<{ selection_revision: number }>();
    const result = await new RunRepository(this.db, this.context).complete(
      token,
      'ANALYZE',
      prepared.run_id,
      await sha256(JSON.stringify(outcome)),
      outcome,
      selection?.selection_revision ?? null,
      current(),
      effects,
      {
        predicate:
          "EXISTS(SELECT 1 FROM items i JOIN sources s ON s.owner_id=i.owner_id AND s.source_id=i.source_id WHERE i.owner_id=? AND i.item_id=? AND s.ai_processing_allowed=1 AND s.access_state='PUBLIC' AND i.availability='PUBLIC') AND ?>?",
        bindings: [
          this.context.ownerId,
          snapshot.source.item_id,
          snapshot.profile.eligibility_expires_at,
          current().toISOString(),
        ],
      },
    );
    return { ...result, state: 'SUCCEEDED', run_id: prepared.run_id };
  }
}
