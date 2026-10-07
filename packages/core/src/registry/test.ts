import { sha256 } from '../auth/crypto.js';
import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { ModelRegistry } from '../ai/models.js';
import type { PipelineProfile } from '../../../contracts/src/ai.js';
import type { PromptSnapshot } from './store.js';
import { PromptDrafts } from './draft.js';
import { validator_schema_hashes } from './generated/validators.js';
import bundle from '../../../../config/registry/master-bundle.json';
import { compileSemanticProfile } from '../ai/semantic-profile.js';

/** A report links verified provider receipts and existing scope qualification.
 * Static validation alone never supplies semantic quality approval. */
export class PromptTests {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async reports(promptId: string, version: number) {
    this.context.requireOwner();
    await new PromptDrafts(this.db, this.context).version(promptId, version);
    const rows = await this.db
      .prepare(
        "SELECT payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id LIKE 'prompt-test-%' AND revision=1 AND json_extract(payload_json,'$.version')='prompt-test-report:1' AND json_extract(payload_json,'$.prompt_id')=? AND json_extract(payload_json,'$.prompt_version')=? ORDER BY created_at DESC,config_id DESC LIMIT 50",
      )
      .bind(this.context.ownerId, promptId, version)
      .all<{ payload_json: string; content_hash: string }>();
    return Promise.all(
      rows.results.map(async (row) => {
        if ((await sha256(row.payload_json)) !== row.content_hash)
          throw new Error('REGISTRY_HASH_MISMATCH');
        return {
          report_hash: row.content_hash,
          report: JSON.parse(row.payload_json) as Awaited<
            ReturnType<PromptTests['record']>
          >['report'],
        };
      }),
    );
  }
  async record(
    promptId: string,
    version: number,
    runId: string,
    modelRevision: number,
    now: Date,
  ) {
    this.context.requireOwner();
    if (!Number.isFinite(now.getTime())) throw new Error('INVALID_PROMPT_TEST');
    const draft = await new PromptDrafts(this.db, this.context).version(
      promptId,
      version,
    );
    const row = await this.db
      .prepare(
        "SELECT j.payload_json,r.prompt_snapshot_json,r.profile_snapshot_json,r.routing_snapshot_json,r.input_snapshot_json,r.outcome_json,r.candidate_hash,r.item_id,u.input_tokens,u.output_tokens,u.total_tokens,u.actual_model,u.reservation_id FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id JOIN quota_reservations q ON q.owner_id=r.owner_id AND q.request_id=r.run_id AND q.job_id=j.job_id JOIN usage_records u ON u.owner_id=q.owner_id AND u.reservation_id=q.reservation_id WHERE r.owner_id=? AND r.run_id=? AND r.state='CANDIDATE' AND r.validation_outcome='DETERMINISTIC_CORE_CANDIDATE' AND j.state='SUCCEEDED' AND j.reason_code='QUALITY_TEST_COMPLETE'",
      )
      .bind(this.context.ownerId, runId)
      .first<{
        prompt_snapshot_json: string;
        payload_json: string;
        profile_snapshot_json: string;
        routing_snapshot_json: string;
        input_snapshot_json: string;
        outcome_json: string;
        candidate_hash: string;
        item_id: string;
        input_tokens: number | null;
        output_tokens: number | null;
        total_tokens: number | null;
        actual_model: string | null;
        reservation_id: string;
      }>();
    if (!row || (await sha256(row.outcome_json)) !== row.candidate_hash)
      throw new Error('PROMPT_TEST_NOT_VERIFIED');
    const prompt = JSON.parse(row.prompt_snapshot_json) as PromptSnapshot;
    const profile = JSON.parse(row.profile_snapshot_json) as PipelineProfile;
    const routing = JSON.parse(row.routing_snapshot_json) as {
      quality_scope: string;
      settings: { mode: string };
    };
    const outcome = JSON.parse(row.outcome_json) as {
      version: string;
      response_artifact_id?: string;
      validation?: {
        status: string;
        canonical_hash: string;
        response_artifact_id: string;
        chunk: unknown;
      };
      mapped?: {
        canonical_hash: string;
        canonical: { status: string };
        coverage?: { complete: boolean };
      };
    };
    const semantic = (
      JSON.parse(row.payload_json) as {
        snapshot: { semantic_profile?: { compiled: { config: unknown } } };
      }
    ).snapshot.semantic_profile;
    const materialized = semantic
      ? await compileSemanticProfile(semantic.compiled.config, bundle)
      : null;
    const wireCompatible = materialized
      ? materialized.prompt.id === promptId &&
        materialized.wire.id === prompt.wire.id &&
        materialized.wire.hash === prompt.wire.hash
      : prompt.wire.id === draft.compatibility.wire_schema_id &&
        prompt.wire.hash ===
          (validator_schema_hashes as Record<string, string>)[prompt.wire.id];
    if (
      prompt.prompt_id !== promptId ||
      prompt.version !== version ||
      prompt.prompt_hash !== draft.prompt_hash ||
      prompt.text !== draft.prompt_text ||
      !wireCompatible ||
      prompt.canonical.id !== draft.compatibility.canonical_schema_id ||
      prompt.canonical.hash !==
        (validator_schema_hashes as Record<string, string>)[
          prompt.canonical.id
        ] ||
      (await sha256(JSON.stringify(prompt.wire.schema))) !== prompt.wire.hash ||
      (await sha256(JSON.stringify(prompt.canonical.schema))) !==
        prompt.canonical.hash ||
      routing.settings.mode !== 'QUALITY_TEST' ||
      !/^[a-f0-9]{64}$/.test(routing.quality_scope)
    )
      throw new Error('PROMPT_TEST_SCOPE_MISMATCH');
    if (outcome.version === 'quality-candidate:1') {
      if (
        outcome.validation?.status !== 'VALIDATED' ||
        outcome.validation.chunk !== null ||
        !outcome.validation.canonical_hash
      )
        throw new Error('PROMPT_TEST_NOT_VERIFIED');
    } else if (outcome.version === 'optional-candidate:1') {
      if (
        outcome.mapped?.canonical.status !== 'OK' ||
        outcome.mapped.coverage?.complete === false
      )
        throw new Error('PROMPT_TEST_NOT_VERIFIED');
    } else throw new Error('PROMPT_TEST_NOT_VERIFIED');
    const artifactId =
      outcome.response_artifact_id ?? outcome.validation?.response_artifact_id;
    const receipt = await this.db
      .prepare(
        "SELECT content_hash,provenance_json FROM artifacts WHERE owner_id=? AND item_id=? AND artifact_id=? AND state='VERIFIED' AND kind='ANALYSIS_CANDIDATE' AND schema_version='provider-output:1' AND producer_version=?",
      )
      .bind(
        this.context.ownerId,
        row.item_id,
        artifactId ?? '',
        'gemini-response:1:' + row.reservation_id,
      )
      .first<{ content_hash: string; provenance_json: string }>();
    if (!receipt) throw new Error('PROMPT_TEST_NOT_VERIFIED');
    const response = JSON.parse(receipt.provenance_json) as {
      reservation_id: string;
      raw_output_present: boolean;
      response: {
        request_id: string;
        status: string;
        actual_provider: string;
        actual_model: string;
        usage: {
          input_tokens: number;
          output_tokens: number;
          total_tokens: number;
        };
      };
    };
    if (
      response.reservation_id !== row.reservation_id ||
      !response.raw_output_present ||
      response.response.request_id !== runId ||
      response.response.status !== 'OK' ||
      response.response.actual_provider !== 'gemini' ||
      response.response.actual_model !== profile.model ||
      row.actual_model !== profile.model ||
      ![row.input_tokens, row.output_tokens, row.total_tokens].every(
        (n) => Number.isSafeInteger(n) && n !== null && n >= 0,
      ) ||
      row.total_tokens !== row.input_tokens! + row.output_tokens! ||
      response.response.usage.input_tokens !== row.input_tokens ||
      response.response.usage.output_tokens !== row.output_tokens ||
      response.response.usage.total_tokens !== row.total_tokens
    )
      throw new Error('PROMPT_TEST_USAGE_NOT_VERIFIED');
    const qualified = await new ModelRegistry(this.db, this.context).load(
      profile.profile_id,
      modelRevision,
    );
    if (
      !qualified ||
      qualified.provider_id !== profile.provider_id ||
      qualified.model !== profile.model ||
      qualified.account_key !== profile.account_key ||
      !qualified.free_eligible ||
      qualified.billing_enabled ||
      Date.parse(qualified.eligibility_expires_at) <= now.getTime() ||
      !qualified.quality_approvals.includes(routing.quality_scope)
    )
      throw new Error('PROMPT_QUALITY_APPROVAL_REQUIRED');
    const value = {
      version: 'prompt-test-report:1',
      prompt_id: promptId,
      prompt_version: version,
      prompt_hash: draft.prompt_hash,
      run_id: runId,
      outcome_hash: row.candidate_hash,
      response_artifact_id: artifactId,
      response_hash: receipt.content_hash,
      input_snapshot_hash: await sha256(row.input_snapshot_json),
      quality_scope: routing.quality_scope,
      model_profile_id: qualified.profile_id,
      model_revision: modelRevision,
      model_hash: await sha256(JSON.stringify(qualified)),
      usage: {
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        total_tokens: row.total_tokens,
      },
      semantic_verification: 'EXISTING_QUALIFIED_SCOPE',
      created_by: this.context.actorId,
      created_at: now.toISOString(),
    };
    const serialized = JSON.stringify(value),
      hash = await sha256(serialized);
    const results = await this.db.batch([
      this.db
        .prepare(
          'INSERT INTO config_versions(config_id,owner_id,revision,payload_json,content_hash,created_at) VALUES(?,?,1,?,?,?) ON CONFLICT DO NOTHING',
        )
        .bind(
          'prompt-test-' + hash,
          this.context.ownerId,
          serialized,
          hash,
          now.toISOString(),
        ),
      this.db
        .prepare(
          "UPDATE prompt_versions SET status='TESTED' WHERE owner_id=? AND prompt_id=? AND version=? AND prompt_hash=? AND status='DRAFT' AND EXISTS(SELECT 1 FROM config_versions WHERE owner_id=? AND config_id=? AND content_hash=?)",
        )
        .bind(
          this.context.ownerId,
          promptId,
          version,
          draft.prompt_hash,
          this.context.ownerId,
          'prompt-test-' + hash,
          hash,
        ),
      this.db
        .prepare(
          "INSERT INTO audit_events SELECT ?,?,?,'PROMPT_TEST_REPORT_RECORDED',?,?,? WHERE EXISTS(SELECT 1 FROM config_versions WHERE owner_id=? AND config_id=? AND content_hash=?) ON CONFLICT DO NOTHING",
        )
        .bind(
          'prompt-test-' + hash,
          this.context.ownerId,
          this.context.actorId,
          promptId + ':' + version,
          hash,
          now.toISOString(),
          this.context.ownerId,
          'prompt-test-' + hash,
          hash,
        ),
    ]);
    if (results[0]?.meta.changes !== 1) {
      const saved = await this.db
        .prepare(
          'SELECT payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
        )
        .bind(this.context.ownerId, 'prompt-test-' + hash)
        .first<{ payload_json: string; content_hash: string }>();
      if (
        !saved ||
        saved.content_hash !== hash ||
        (await sha256(saved.payload_json)) !== hash
      )
        throw new Error('PROMPT_TEST_NOT_VERIFIED');
    }
    return {
      report_hash: hash,
      report: value,
      prompt_state: (
        await new PromptDrafts(this.db, this.context).version(promptId, version)
      ).status,
    };
  }
}
