import { assertContext, AccessContext, type Database } from '../db/boundary.js';
import { ArtifactRepository } from '../artifacts/store.js';
import { RepresentationRepository } from './representations.js';
import type { LanguageSelection } from './language.js';
import { RunRepository } from '../jobs/acceptance.js';
import { sha256 } from '../auth/crypto.js';
import type { LeaseToken } from '../../../contracts/src/jobs.js';
export interface TranscriptSourceCompletion {
  raw_artifact_id: string;
  source_artifact_id: string;
  normalized_artifact_id: string;
  segment_map_artifact_id: string;
  offset_map_artifact_id: string;
  selection: LanguageSelection;
  warnings: string[];
}
export class TranscriptAcceptance {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async accept(
    input: TranscriptSourceCompletion,
    token: LeaseToken,
    now: Date,
  ) {
    this.context.requireTask('FETCH_TRANSCRIPT');
    (
      await AccessContext.worker(this.db, this.context.credentialHash!)
    ).requireTask('FETCH_TRANSCRIPT');
    const selection = input.selection,
      track = selection?.source;
    if (
      selection?.status !== 'SELECTED' ||
      selection.policy_version !== 'original-authority:1' ||
      !track ||
      track.is_translated !== false ||
      !['MANUAL', 'GENERATED'].includes(track.track_kind) ||
      track.is_generated !== (track.track_kind === 'GENERATED') ||
      track.is_original === false ||
      !(track.is_original === null || track.is_original === true) ||
      !['EXPLICIT_ORIGINAL', 'VIDEO_LANGUAGE', 'AVAILABLE_ONLY'].includes(
        selection.authority_basis ?? '',
      ) ||
      selection.authority_confidence !==
        (selection.authority_basis === 'AVAILABLE_ONLY'
          ? 'LOW'
          : 'CONFIRMED') ||
      typeof track.language_code !== 'string' ||
      !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{1,8})*$/.test(track.language_code) ||
      typeof track.track_id !== 'string' ||
      track.track_id.length < 1 ||
      track.track_id.length > 256 ||
      !Array.isArray(input.warnings) ||
      input.warnings.length > 1 ||
      input.warnings.some((warning) => warning !== 'SOURCE_DURATION_OVERRUN') ||
      !/^[a-f0-9]{64}$/.test(selection.source_revision)
    )
      throw new Error('INVALID_SOURCE_COMPLETION');
    const runId =
      'transcript_' +
      (await sha256(
        JSON.stringify({
          owner: this.context.ownerId,
          job: token.job_id,
          source: input.source_artifact_id,
        }),
      ));
    const outcome = {
      version: 'transcript-source:1',
      raw_artifact_id: input.raw_artifact_id,
      source_artifact_id: input.source_artifact_id,
      normalized_artifact_id: input.normalized_artifact_id,
      segment_map_artifact_id: input.segment_map_artifact_id,
      offset_map_artifact_id: input.offset_map_artifact_id,
      source_hash: selection.source_revision,
      authority: {
        track_id: track.track_id,
        language_code: track.language_code,
        track_kind: track.track_kind,
        authority_basis: selection.authority_basis,
        authority_confidence: selection.authority_confidence,
      },
      warnings: [...new Set(input.warnings)].sort(),
    };
    const hash = await sha256(JSON.stringify(outcome));
    const duplicate = await this.db
      .prepare(
        `SELECT 1 FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.run_id=? AND r.job_id=? AND r.state='ACCEPTED' AND r.candidate_hash=? AND j.state='SUCCEEDED' AND j.fencing_token=? AND EXISTS(SELECT 1 FROM job_attempts a WHERE a.owner_id=r.owner_id AND a.job_id=r.job_id AND a.fencing_token=? AND a.executor_id=?)`,
      )
      .bind(
        this.context.ownerId,
        runId,
        token.job_id,
        hash,
        token.fencing_token,
        token.fencing_token,
        this.context.actorId,
      )
      .first();
    if (duplicate) return { accepted: true, duplicate: true, run_id: runId };
    const repository = new ArtifactRepository(this.db, this.context);
    const entries = [
      ['RAW', input.raw_artifact_id],
      ['SOURCE_ORIGINAL', input.source_artifact_id],
      ['NORMALIZED', input.normalized_artifact_id],
      ['SEGMENT_MAP', input.segment_map_artifact_id],
      ['OFFSET_MAP', input.offset_map_artifact_id],
    ] as const;
    if (new Set(entries.map((entry) => entry[1])).size !== 5)
      throw new Error('INVALID_SOURCE_ARTIFACT_SET');
    const artifacts = await Promise.all(
      entries.map(async ([kind, id]) => {
        const artifact = await repository.get(
          id,
          token,
          'FETCH_TRANSCRIPT',
          now,
        );
        if (
          artifact.kind !== kind ||
          artifact.state !== 'VERIFIED' ||
          artifact.item_id !== track.item_id ||
          artifact.byte_size < 1
        )
          throw new Error('SOURCE_ARTIFACT_NOT_VERIFIED');
        const provenance = JSON.parse(artifact.provenance_json) as Record<
          string,
          unknown
        >;
        if (
          provenance.provider_id !== 'local_ytdlp' ||
          provenance.upstream_track_id !== track.track_id ||
          provenance.language_code !== track.language_code ||
          provenance.track_kind !== track.track_kind ||
          provenance.is_generated !== track.is_generated ||
          provenance.is_translated !== false
        )
          throw new Error('SOURCE_ARTIFACT_PROVENANCE_MISMATCH');
        const originalLanguage = track.language_code
          .toLowerCase()
          .split('-')[0];
        if (
          provenance.is_original !== track.is_original ||
          (selection.authority_basis === 'EXPLICIT_ORIGINAL' &&
            (typeof provenance.original_language !== 'string' ||
              provenance.original_language.toLowerCase().split('-')[0] !==
                originalLanguage)) ||
          (selection.authority_basis === 'VIDEO_LANGUAGE' &&
            (typeof provenance.video_language !== 'string' ||
              provenance.video_language.toLowerCase().split('-')[0] !==
                originalLanguage)) ||
          (selection.authority_basis === 'AVAILABLE_ONLY' &&
            (originalLanguage !== 'pl' ||
              provenance.video_language !== null ||
              provenance.original_language !== null ||
              provenance.is_original === true))
        )
          throw new Error('SOURCE_AUTHORITY_MISMATCH');
        if (kind === 'RAW' || kind === 'SOURCE_ORIGINAL') {
          if (
            artifact.producer_version !==
              'yt-dlp@2026.08.19+yt-dlp-ejs@0.8.0' ||
            artifact.original_ref !== null
          )
            throw new Error('SOURCE_PROVIDER_NOT_QUALIFIED');
        } else if (
          artifact.original_ref !== input.source_artifact_id ||
          artifact.producer_version !== 'source-normalizer:1' ||
          provenance.source_revision !== selection.source_revision
        )
          throw new Error('NORMALIZED_SOURCE_MISMATCH');
        return artifact;
      }),
    );
    if (artifacts[1]!.content_hash !== selection.source_revision)
      throw new Error('REPRESENTATION_REVISION_MISMATCH');
    await new RepresentationRepository(this.db, this.context).record(
      input.source_artifact_id,
      selection,
      'SOURCE_AUTHORITY',
      token,
      'FETCH_TRANSCRIPT',
      now,
    );
    const runs = new RunRepository(this.db, this.context);
    await runs.prepare(runId, token.job_id, now.toISOString());
    const result = await runs.complete(
      token,
      'FETCH_TRANSCRIPT',
      runId,
      hash,
      outcome,
      null,
      now,
    );
    return { ...result, run_id: runId };
  }
}
