import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { ArtifactRepository } from '../artifacts/store.js';
import { decode64, sha256 } from '../auth/crypto.js';
import { leasePredicate } from '../jobs/lease-guard.js';
import type { LeaseToken } from '../../../contracts/src/jobs.js';
import { AnalysisJobs } from './jobs.js';
import { RunRepository } from '../jobs/acceptance.js';
import { AnalysisResponses, type ResponseMetadata } from './responses.js';
import { IntelligenceLedger } from './enrichment/ledger.js';
import { enrichEconomy } from './enrichment/canonical.js';
import { validateEconomyCandidate } from './repair/validate.js';
import type { normalizeTranscript } from '../transcript/normalize.js';
import { validator_schema_hashes } from '../registry/generated/validators.js';
export interface AnalysisValidationResult {
  version: 'analysis-validation:1';
  run_id: string;
  response_artifact_id: string;
  context_hash: string;
  mode: 'QUALITY_TEST' | 'PRODUCTION';
  status: 'VALIDATED' | 'REVIEW_REQUIRED' | 'INVALID';
  reason: string | null;
  canonical_artifact_id: string | null;
  canonical_hash: string | null;
  semantic_verification: 'NOT_ASSERTED';
  accepted: false;
}

export class AnalysisValidation {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async evaluate(
    token: LeaseToken,
    reservationId: string,
    candidateId: string,
    now: Date,
    secret: string,
  ): Promise<AnalysisValidationResult> {
    return (
      await this.process(token, reservationId, candidateId, now, secret, false)
    ).validation;
  }
  async complete(
    token: LeaseToken,
    reservationId: string,
    candidateId: string,
    now: Date,
    secret: string,
  ) {
    this.context.requireTask('ANALYZE');
    if (token.lease_owner !== this.context.actorId)
      throw new Error('STALE_FENCE');
    const duplicate = await this.db
      .prepare(
        `SELECT r.run_id,r.outcome_json,r.candidate_hash FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id JOIN job_attempts a ON a.owner_id=j.owner_id AND a.job_id=j.job_id JOIN worker_identities w ON w.owner_id=j.owner_id AND w.worker_id=a.executor_id AND w.worker_id=? WHERE r.owner_id=? AND j.job_id=? AND j.task_type='ANALYZE' AND j.state='SUCCEEDED' AND r.state='ACCEPTED' AND a.fencing_token=? AND a.candidate_hash=r.candidate_hash AND w.credential_hash=? AND w.revoked_at IS NULL`,
      )
      .bind(
        this.context.actorId,
        this.context.ownerId,
        token.job_id,
        token.fencing_token,
        this.context.credentialHash!,
      )
      .first<{
        run_id: string;
        outcome_json: string;
        candidate_hash: string;
      }>();
    if (duplicate) {
      const outcome = JSON.parse(duplicate.outcome_json) as {
        version: string;
        response_artifact_id: string;
        reservation_id: string;
      };
      if (
        (await sha256(duplicate.outcome_json)) !== duplicate.candidate_hash ||
        outcome.version !== 'intelligence-accepted:1' ||
        outcome.response_artifact_id !== candidateId ||
        outcome.reservation_id !== reservationId
      )
        throw new Error('INVALID_COMPLETION');
      return {
        accepted: true,
        active: false,
        duplicate: true,
        run_id: duplicate.run_id,
      };
    }
    const result = await this.process(
      token,
      reservationId,
      candidateId,
      now,
      secret,
      true,
    );
    if (!result.completion) throw new Error('ANALYSIS_NOT_ACCEPTABLE');
    return { ...result.completion, run_id: result.validation.run_id };
  }
  async finishQualityTest(
    token: LeaseToken,
    reservationId: string,
    candidateId: string,
    now: Date,
    secret: string,
  ) {
    const started = Date.now();
    this.context.requireTask('ANALYZE');
    if (token.lease_owner !== this.context.actorId)
      throw new Error('STALE_FENCE');
    const prior = await this.db
      .prepare(
        "SELECT r.run_id,r.outcome_json,r.candidate_hash FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id JOIN job_attempts a ON a.owner_id=j.owner_id AND a.job_id=j.job_id JOIN worker_identities w ON w.owner_id=a.owner_id AND w.worker_id=a.executor_id WHERE r.owner_id=? AND j.job_id=? AND j.task_type='ANALYZE' AND j.state='SUCCEEDED' AND j.reason_code='QUALITY_TEST_COMPLETE' AND r.state='CANDIDATE' AND a.fencing_token=? AND w.worker_id=? AND w.credential_hash=? AND w.revoked_at IS NULL AND a.candidate_hash=r.candidate_hash",
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
        outcome_json: string;
        candidate_hash: string;
      }>();
    if (prior) {
      const outcome = JSON.parse(prior.outcome_json) as {
        version: string;
        reservation_id: string;
        validation: AnalysisValidationResult;
      };
      if (
        (await sha256(prior.outcome_json)) !== prior.candidate_hash ||
        outcome.version !== 'quality-candidate:1' ||
        outcome.reservation_id !== reservationId ||
        outcome.validation.response_artifact_id !== candidateId ||
        outcome.validation.accepted !== false
      )
        throw new Error('INVALID_COMPLETION');
      return {
        accepted: false,
        run_id: prior.run_id,
        state: 'SUCCEEDED',
        candidate_status: 'VALIDATED',
      };
    }
    const validation = await this.evaluate(
      token,
      reservationId,
      candidateId,
      now,
      secret,
    );
    if (validation.mode !== 'QUALITY_TEST' || validation.status !== 'VALIDATED')
      throw new Error('QUALITY_TEST_NOT_FINISHABLE');
    now = new Date(now.getTime() + Date.now() - started);
    const guard = leasePredicate(
      this.context,
      token,
      now.toISOString(),
      'ANALYZE',
    );
    const outcome = JSON.stringify({
      version: 'quality-candidate:1',
      validation,
      reservation_id: reservationId,
    });
    const hash = await sha256(outcome),
      nonce = crypto.randomUUID();
    const active = `${guard.predicate} AND EXISTS(SELECT 1 FROM job_attempts WHERE owner_id=? AND job_id=? AND fencing_token=? AND commit_nonce=?)`;
    const bindings = [
      ...guard.bindings,
      this.context.ownerId,
      token.job_id,
      token.fencing_token,
      nonce,
    ];
    const result = await this.db.batch([
      this.db
        .prepare(
          `UPDATE job_attempts SET commit_nonce=?,candidate_hash=?,finished_at=? WHERE owner_id=? AND job_id=? AND fencing_token=? AND commit_nonce IS NULL AND ${guard.predicate} AND EXISTS(SELECT 1 FROM analysis_runs WHERE owner_id=? AND run_id=? AND job_id=? AND state='CANDIDATE' AND candidate_hash IS NULL)`,
        )
        .bind(
          nonce,
          hash,
          now.toISOString(),
          this.context.ownerId,
          token.job_id,
          token.fencing_token,
          ...guard.bindings,
          this.context.ownerId,
          validation.run_id,
          token.job_id,
        ),
      this.db
        .prepare(
          `UPDATE analysis_runs SET candidate_hash=?,outcome_json=?,validation_outcome='DETERMINISTIC_CORE_CANDIDATE' WHERE owner_id=? AND job_id=? AND run_id=? AND state='CANDIDATE' AND ${active}`,
        )
        .bind(
          hash,
          outcome,
          this.context.ownerId,
          token.job_id,
          validation.run_id,
          ...bindings,
        ),
      this.db
        .prepare(
          `UPDATE jobs SET state='SUCCEEDED',reason_code='QUALITY_TEST_COMPLETE',result_candidate_id=?,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE owner_id=? AND job_id=? AND state='RUNNING' AND ${active}`,
        )
        .bind(
          validation.run_id,
          now.toISOString(),
          this.context.ownerId,
          token.job_id,
          ...bindings,
        ),
    ]);
    if (result.some((row) => row.meta.changes !== 1))
      throw new Error('STALE_FENCE');
    return {
      accepted: false,
      run_id: validation.run_id,
      state: 'SUCCEEDED',
      candidate_status: 'VALIDATED',
    };
  }
  private async process(
    token: LeaseToken,
    reservationId: string,
    candidateId: string,
    now: Date,
    secret: string,
    commit: boolean,
  ): Promise<{
    validation: AnalysisValidationResult;
    completion?: { accepted: boolean; active: boolean; duplicate: boolean };
  }> {
    const started = Date.now(),
      current = () => new Date(now.getTime() + Date.now() - started);
    const jobs = new AnalysisJobs(this.db, this.context),
      prepared = await jobs.prepareRun(token, current()),
      snapshot = prepared.snapshot;
    if (commit && snapshot.settings.mode !== 'PRODUCTION')
      throw new Error('QUALITY_TEST_NOT_ACCEPTABLE');
    if (
      snapshot.prompt.wire.hash !==
        validator_schema_hashes['urn:bartosz:schema:economy-wire:1.0'] ||
      snapshot.prompt.canonical.hash !==
        validator_schema_hashes['urn:bartosz:schema:intelligence-canonical:1.2']
    )
      throw new Error('INCOMPATIBLE_PROMPT_SNAPSHOT');
    const repo = new ArtifactRepository(this.db, this.context);
    const candidate = await repo.get(candidateId, token, 'ANALYZE', current());
    const provenance = JSON.parse(candidate.provenance_json) as {
      reservation_id: string;
      response: ResponseMetadata;
      raw_output_present: boolean;
    };
    if (
      candidate.item_id !== snapshot.source.item_id ||
      candidate.kind !== 'ANALYSIS_CANDIDATE' ||
      provenance.reservation_id !== reservationId ||
      provenance.response?.request_id !== prepared.run_id ||
      (provenance.response.status === 'OK' &&
        provenance.response.actual_model !== snapshot.profile.model)
    )
      throw new Error('INVALID_AI_RESPONSE_RECEIPT');
    await new AnalysisResponses(this.db, this.context).record(
      token,
      reservationId,
      candidateId,
      current(),
    );
    const receipt = await this.db
      .prepare(
        'SELECT payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, 'analysis-request-' + prepared.run_id)
      .first<{ payload_json: string; content_hash: string }>();
    if (
      !receipt ||
      (await sha256(receipt.payload_json)) !== receipt.content_hash
    )
      throw new Error('ANALYSIS_CONTEXT_REQUIRED');
    const contextHash = (
      JSON.parse(receipt.payload_json) as { context_hash: string }
    ).context_hash;
    const resultKey =
      'analysis-validation-' + prepared.run_id + '-' + candidateId;
    const prior = await this.db
      .prepare(
        'SELECT payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, resultKey)
      .first<{ payload_json: string; content_hash: string }>();
    if (prior && !commit) {
      if ((await sha256(prior.payload_json)) !== prior.content_hash)
        throw new Error('ANALYSIS_VALIDATION_CONFLICT');
      const value = JSON.parse(prior.payload_json) as AnalysisValidationResult;
      if (
        value.version !== 'analysis-validation:1' ||
        value.run_id !== prepared.run_id ||
        value.context_hash !== contextHash ||
        value.response_artifact_id !== candidateId ||
        value.mode !== snapshot.settings.mode ||
        value.accepted !== false
      )
        throw new Error('ANALYSIS_VALIDATION_CONFLICT');
      if (value.canonical_artifact_id) {
        const canonical = await repo.get(
          value.canonical_artifact_id,
          token,
          'ANALYZE',
          current(),
        );
        if (
          canonical.state !== 'VERIFIED' ||
          canonical.content_hash !== value.canonical_hash ||
          canonical.original_ref !== snapshot.source.source_artifact_id ||
          canonical.kind !== 'ANALYSIS_CANDIDATE' ||
          canonical.schema_version !== 'intelligence-canonical:1.2'
        )
          throw new Error('ANALYSIS_VALIDATION_CONFLICT');
      }
      return { validation: value };
    }
    const read = async (id: string, kind: string, max: number) => {
      const header = await repo.get(id, token, 'ANALYZE', current());
      if (
        header.state !== 'VERIFIED' ||
        header.item_id !== snapshot.source.item_id ||
        header.kind !== kind ||
        header.byte_size > max
      )
        throw new Error('INVALID_AI_VALIDATION_ARTIFACT');
      const data = new Uint8Array(header.byte_size);
      let offset = 0;
      for (let i = 0; i < header.chunk_count; i++) {
        const chunk = await repo.chunk(id, i, token, 'ANALYZE', current()),
          bytes = chunk.body_base64
            ? decode64(chunk.body_base64)
            : new Uint8Array();
        if (chunk.byte_start !== offset || offset + bytes.length > data.length)
          throw new Error('ARTIFACT_RANGE_MISMATCH');
        data.set(bytes, offset);
        offset += bytes.length;
      }
      const text = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(data);
      if (
        offset !== data.length ||
        (await sha256(text)) !== header.content_hash
      )
        throw new Error('ARTIFACT_CONTENT_HASH_MISMATCH');
      return text;
    };
    const raw = await read(candidateId, 'ANALYSIS_CANDIDATE', 2 * 1024 * 1024);
    let reason: string | null = null;
    let enriched: Awaited<ReturnType<typeof enrichEconomy>> | null = null;
    if (provenance.response.status !== 'OK' || !provenance.raw_output_present)
      reason = provenance.response.status;
    else {
      const sourceText = await read(
        snapshot.source.source_artifact_id,
        'SOURCE_ORIGINAL',
        4 * 1024 * 1024,
      );
      const manifest = JSON.parse(
        await read(
          snapshot.source.segment_map_artifact_id,
          'SEGMENT_MAP',
          32 * 1024 * 1024,
        ),
      ) as Awaited<ReturnType<typeof normalizeTranscript>>['manifest'];
      let checked: Awaited<ReturnType<typeof validateEconomyCandidate>> | null =
        null;
      try {
        checked = await validateEconomyCandidate(
          raw,
          'OK',
          new Set(manifest.anchors.map((a) => a.alias)),
        );
      } catch (error) {
        const categories = new Set([
          'JSON_TOO_LARGE',
          'JSON_COMPLEXITY_LIMIT',
          'DUPLICATE_JSON_KEY',
          'INVALID_JSON_STRING',
          'INVALID_JSON_OBJECT',
          'INVALID_JSON_ARRAY',
          'INVALID_JSON_NUMBER',
          'INVALID_JSON_TOKEN',
          'TRUNCATED_JSON',
          'TRAILING_JSON_CONTENT',
          'INVALID_ANALYSIS_ROOT',
          'NON_OUTER_REPAIR',
        ]);
        if (error instanceof SyntaxError) reason = 'INVALID_JSON_STRING';
        else if (error instanceof Error && categories.has(error.message))
          reason = error.message;
        else throw error;
      }
      if (checked && !checked.valid) reason = checked.reason;
      else if (checked) {
        const item = await this.db
          .prepare(
            'SELECT canonical_url FROM items WHERE owner_id=? AND item_id=?',
          )
          .bind(this.context.ownerId, snapshot.source.item_id)
          .first<{ canonical_url: string }>();
        enriched = await enrichEconomy({
          raw,
          completion: 'OK',
          run_id: prepared.run_id,
          item_id: snapshot.source.item_id,
          profile_id: snapshot.profile.profile_id,
          profile_revision: prepared.snapshot_hash,
          source: {
            owner_id: this.context.ownerId,
            source_artifact_id: snapshot.source.source_artifact_id,
            source_text: sourceText,
            manifest,
            manifest_hash: snapshot.source.manifest_hash,
            video_url: item?.canonical_url ?? null,
          },
          approved_aliases: await new IntelligenceLedger(
            this.db,
            this.context,
          ).aliases(token, current()),
        });
      }
    }
    await jobs.load(token, current());
    let canonicalId: string | null = null;
    if (enriched) {
      const text = JSON.stringify(enriched.canonical),
        bytes = new TextEncoder().encode(text),
        count = Math.ceil(bytes.length / 32768);
      const artifact = await repo.begin(
        {
          item_id: snapshot.source.item_id,
          kind: 'ANALYSIS_CANDIDATE',
          content_hash: enriched.canonical_hash,
          byte_size: bytes.length,
          chunk_count: count,
          schema_version: 'intelligence-canonical:1.2',
          producer_version:
            'core-enrichment:1:' + prepared.run_id + ':' + candidateId,
          original_ref: snapshot.source.source_artifact_id,
          provenance: {
            run_id: prepared.run_id,
            response_artifact_id: candidateId,
            context_hash: contextHash,
            semantic_verification: 'NOT_ASSERTED',
          },
        },
        token,
        'ANALYZE',
        current(),
      );
      if (artifact.state !== 'VERIFIED') {
        for (let i = 0; i < count; i++)
          await repo.writeChunk(
            artifact.artifact_id,
            i,
            i * 32768,
            bytes.slice(i * 32768, (i + 1) * 32768),
            token,
            'ANALYZE',
            current(),
          );
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
      canonicalId = artifact.artifact_id;
    }
    await jobs.load(token, current());
    const result: AnalysisValidationResult = {
      version: 'analysis-validation:1',
      run_id: prepared.run_id,
      response_artifact_id: candidateId,
      context_hash: contextHash,
      mode: snapshot.settings.mode,
      status: enriched
        ? 'VALIDATED'
        : reason === 'REVIEW_REQUIRED'
          ? 'REVIEW_REQUIRED'
          : 'INVALID',
      reason,
      canonical_artifact_id: canonicalId,
      canonical_hash: enriched?.canonical_hash ?? null,
      semantic_verification: 'NOT_ASSERTED',
      accepted: false,
    };
    const payload = JSON.stringify(result),
      hash = await sha256(payload),
      key = resultKey,
      guard = leasePredicate(
        this.context,
        token,
        current().toISOString(),
        'ANALYZE',
      );
    await this.db
      .prepare(
        `INSERT INTO config_versions(config_id,owner_id,revision,payload_json,content_hash,created_at) SELECT ?,?,1,?,?,? WHERE ${guard.predicate} ON CONFLICT DO NOTHING`,
      )
      .bind(
        key,
        this.context.ownerId,
        payload,
        hash,
        current().toISOString(),
        ...guard.bindings,
      )
      .run();
    const saved = await this.db
      .prepare(
        'SELECT content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, key)
      .first<{ content_hash: string }>();
    if (saved?.content_hash !== hash)
      throw new Error('ANALYSIS_VALIDATION_CONFLICT');
    if (!commit) return { validation: result };
    if (!enriched || result.status !== 'VALIDATED')
      throw new Error('ANALYSIS_NOT_ACCEPTABLE');
    const effects = await new IntelligenceLedger(this.db, this.context).prepare(
      enriched,
      prepared.run_id,
      token,
      current(),
    );
    const selection = await this.db
      .prepare(
        'SELECT selection_revision FROM active_analysis_selections WHERE owner_id=? AND item_id=? AND requested_run_id=?',
      )
      .bind(this.context.ownerId, snapshot.source.item_id, prepared.run_id)
      .first<{ selection_revision: number }>();
    const outcome = {
      version: 'intelligence-accepted:1',
      run_id: prepared.run_id,
      canonical_artifact_id: canonicalId,
      canonical_hash: enriched.canonical_hash,
      response_artifact_id: candidateId,
      reservation_id: reservationId,
      context_hash: contextHash,
      source_run_id: snapshot.source.run_id,
      source_artifact_id: snapshot.source.source_artifact_id,
      quality_scope: snapshot.quality_scope,
      semantic_verification: 'NOT_ASSERTED',
    };
    await jobs.load(token, current());
    const completion = await new RunRepository(this.db, this.context).complete(
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
    return { validation: result, completion };
  }
}
