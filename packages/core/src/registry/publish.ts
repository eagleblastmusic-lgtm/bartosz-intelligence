import { sha256 } from '../auth/crypto.js';
import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { ModelRegistry } from '../ai/models.js';
import { PromptDrafts } from './draft.js';
import { PromptRegistry, promptPointerKey } from './store.js';
import type { PromptTests } from './test.js';
import { PromptUsage, promptUseKey } from './usage.js';
type TestReport = Awaited<ReturnType<PromptTests['record']>>['report'];
interface Publication {
  version: 'prompt-publication-preview:1';
  created_at: string;
  action: 'PUBLISH' | 'ROLLBACK';
  prompt_id: string;
  prompt_version: number;
  prompt_hash: string;
  expected_generation: number;
  previous_version: number | null;
  previous_hash: string | null;
  report_hash: string | null;
  reason: string;
}
export class PromptPublications {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  private async report(
    hash: string,
    promptId: string,
    version: number,
    promptHash: string,
    now: Date,
  ) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('INVALID_PROMPT_REPORT');
    const row = await this.db
      .prepare(
        'SELECT payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, 'prompt-test-' + hash)
      .first<{ payload_json: string; content_hash: string }>();
    if (
      !row ||
      row.content_hash !== hash ||
      (await sha256(row.payload_json)) !== hash
    )
      throw new Error('PROMPT_TEST_NOT_VERIFIED');
    const report = JSON.parse(row.payload_json) as TestReport;
    if (
      report.version !== 'prompt-test-report:1' ||
      report.prompt_id !== promptId ||
      report.prompt_version !== version ||
      report.prompt_hash !== promptHash
    )
      throw new Error('PROMPT_TEST_SCOPE_MISMATCH');
    const model = await new ModelRegistry(this.db, this.context).load(
      report.model_profile_id,
      report.model_revision,
    );
    if (
      !model ||
      (await sha256(JSON.stringify(model))) !== report.model_hash ||
      !model.quality_approvals.includes(report.quality_scope) ||
      !model.free_eligible ||
      model.billing_enabled ||
      Date.parse(model.eligibility_expires_at) <= now.getTime()
    )
      throw new Error('PROMPT_QUALITY_APPROVAL_REQUIRED');
    return report;
  }
  async preview(
    input: {
      action: 'PUBLISH' | 'ROLLBACK';
      prompt_id: string;
      version: number;
      report_hash: string | null;
      reason: string;
    },
    now: Date,
  ) {
    this.context.requireOwner();
    if (
      !['PUBLISH', 'ROLLBACK'].includes(input.action) ||
      !input.reason?.trim() ||
      input.reason.length > 1000 ||
      !Number.isFinite(now.getTime())
    )
      throw new Error('INVALID_PROMPT_PUBLICATION');
    const target = await new PromptDrafts(this.db, this.context).version(
        input.prompt_id,
        input.version,
      ),
      key = promptPointerKey(input.prompt_id);
    await new PromptUsage(this.db, this.context).requireNewUse(
      input.prompt_id,
      input.version,
    );
    const current = await this.db
      .prepare(
        'SELECT COALESCE(MAX(revision),0) generation FROM config_versions WHERE owner_id=? AND config_id=?',
      )
      .bind(this.context.ownerId, key)
      .first<{ generation: number }>();
    if (input.action === 'PUBLISH') {
      if (target.status !== 'TESTED' || !input.report_hash)
        throw new Error('PROMPT_TEST_NOT_VERIFIED');
      await this.report(
        input.report_hash,
        input.prompt_id,
        input.version,
        target.prompt_hash,
        now,
      );
    } else {
      if (
        target.status !== 'PUBLISHED' ||
        input.report_hash !== null ||
        !(await this.db
          .prepare(
            "SELECT 1 FROM config_versions WHERE owner_id=? AND config_id=? AND ((json_extract(payload_json,'$.version')=? AND json_extract(payload_json,'$.prompt_hash')=?) OR (json_extract(payload_json,'$.previous_version')=? AND json_extract(payload_json,'$.previous_hash')=?)) LIMIT 1",
          )
          .bind(
            this.context.ownerId,
            key,
            input.version,
            target.prompt_hash,
            input.version,
            target.prompt_hash,
          )
          .first())
      )
        throw new Error('INVALID_PROMPT_ROLLBACK');
    }
    let previous: Awaited<ReturnType<PromptRegistry['currentFamily']>> | null =
      null;
    try {
      previous = await new PromptRegistry(this.db, this.context).currentFamily(
        input.prompt_id,
        true,
      );
    } catch (error) {
      if (!(
        error instanceof Error && error.message === 'PROMPT_NOT_CONFIGURED'
      ))
        throw error;
    }
    if (previous && previous.generation !== current!.generation)
      throw new Error('REGISTRY_GENERATION_CONFLICT');
    const value: Publication = {
      version: 'prompt-publication-preview:1',
      created_at: now.toISOString(),
      action: input.action,
      prompt_id: input.prompt_id,
      prompt_version: input.version,
      prompt_hash: target.prompt_hash,
      expected_generation: current!.generation,
      previous_version: previous?.version ?? null,
      previous_hash: previous?.prompt_hash ?? null,
      report_hash: input.report_hash,
      reason: input.reason.trim(),
    };
    const text = JSON.stringify(value),
      hash = await sha256(text);
    await this.db
      .prepare(
        'INSERT INTO config_versions VALUES(?,?,1,?,?,?) ON CONFLICT DO NOTHING',
      )
      .bind(
        'prompt-publication-preview-' + hash,
        this.context.ownerId,
        text,
        hash,
        now.toISOString(),
      )
      .run();
    return {
      preview_hash: hash,
      action: value.action,
      prompt_id: value.prompt_id,
      target_version: value.prompt_version,
      expected_generation: value.expected_generation,
      report_hash: value.report_hash,
      new_model_requests: 0,
      selection_effect: 'NONE',
      reprocess_jobs: 0,
    };
  }
  async confirm(hash: string, nonce: string, now: Date) {
    this.context.requireOwner();
    if (
      !/^[a-f0-9]{64}$/.test(hash) ||
      !/^[a-f0-9-]{36}$/.test(nonce) ||
      !Number.isFinite(now.getTime())
    )
      throw new Error('INVALID_PROMPT_PUBLICATION');
    const row = await this.db
      .prepare(
        'SELECT payload_json,content_hash,created_at FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, 'prompt-publication-preview-' + hash)
      .first<{
        payload_json: string;
        content_hash: string;
        created_at: string;
      }>();
    if (
      !row ||
      row.content_hash !== hash ||
      (await sha256(row.payload_json)) !== hash ||
      now.getTime() - Date.parse(row.created_at) > 900000 ||
      now.getTime() < Date.parse(row.created_at)
    )
      throw new Error('READ_SNAPSHOT_CHANGED');
    const value = JSON.parse(row.payload_json) as Publication;
    if (
      value.version !== 'prompt-publication-preview:1' ||
      value.created_at !== row.created_at
    )
      throw new Error('READ_SNAPSHOT_CHANGED');
    const target = await new PromptDrafts(this.db, this.context).version(
      value.prompt_id,
      value.prompt_version,
    );
    if (target.prompt_hash !== value.prompt_hash)
      throw new Error('REGISTRY_HASH_MISMATCH');
    await new PromptUsage(this.db, this.context).requireNewUse(
      value.prompt_id,
      value.prompt_version,
    );
    if (value.action === 'PUBLISH') {
      if (
        !value.report_hash ||
        !['TESTED', 'PUBLISHED'].includes(target.status)
      )
        throw new Error('PROMPT_TEST_NOT_VERIFIED');
      await this.report(
        value.report_hash,
        value.prompt_id,
        value.prompt_version,
        target.prompt_hash,
        now,
      );
    } else if (value.action !== 'ROLLBACK' || target.status !== 'PUBLISHED')
      throw new Error('INVALID_PROMPT_ROLLBACK');
    const key = promptPointerKey(value.prompt_id),
      generation = value.expected_generation + 1;
    const intent = JSON.stringify({ preview_hash: hash }),
      intentHash = await sha256(intent);
    const payload = JSON.stringify({
        prompt_id: value.prompt_id,
        version: value.prompt_version,
        prompt_hash: value.prompt_hash,
        previous_version: value.previous_version,
        previous_hash: value.previous_hash,
        action: value.action,
        report_hash: value.report_hash,
        preview_hash: hash,
        nonce,
        reason: value.reason,
      }),
      pointerHash = await sha256(payload);
    await this.db.batch([
      this.db
        .prepare(
          'INSERT INTO config_versions VALUES(?,?,1,?,?,?) ON CONFLICT DO NOTHING',
        )
        .bind(
          'prompt-action-' + nonce,
          this.context.ownerId,
          intent,
          intentHash,
          now.toISOString(),
        ),
      this.db
        .prepare(
          'INSERT INTO config_versions SELECT ?,?,?,?, ?,? WHERE (SELECT COALESCE(MAX(revision),0) FROM config_versions WHERE owner_id=? AND config_id=?)=? AND EXISTS(SELECT 1 FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1 AND content_hash=?) AND NOT EXISTS(SELECT 1 FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1) ON CONFLICT DO NOTHING',
        )
        .bind(
          key,
          this.context.ownerId,
          generation,
          payload,
          pointerHash,
          now.toISOString(),
          this.context.ownerId,
          key,
          value.expected_generation,
          this.context.ownerId,
          'prompt-action-' + nonce,
          intentHash,
          this.context.ownerId,
          promptUseKey(value.prompt_id, value.prompt_version),
        ),
      this.db
        .prepare(
          "UPDATE prompt_versions SET status='PUBLISHED' WHERE owner_id=? AND prompt_id=? AND version=? AND status='TESTED' AND EXISTS(SELECT 1 FROM config_versions WHERE owner_id=? AND config_id=? AND revision=? AND content_hash=?)",
        )
        .bind(
          this.context.ownerId,
          value.prompt_id,
          value.prompt_version,
          this.context.ownerId,
          key,
          generation,
          pointerHash,
        ),
      this.db
        .prepare(
          'INSERT INTO audit_events SELECT ?,?,?,?,?,? ,? WHERE EXISTS(SELECT 1 FROM config_versions WHERE owner_id=? AND config_id=? AND revision=? AND content_hash=?) ON CONFLICT DO NOTHING',
        )
        .bind(
          'prompt-publication-' + this.context.ownerId + '-' + nonce,
          this.context.ownerId,
          this.context.actorId,
          'PROMPT_' + value.action,
          value.prompt_id + ':' + value.prompt_version,
          hash,
          now.toISOString(),
          this.context.ownerId,
          key,
          generation,
          pointerHash,
        ),
    ]);
    const savedIntent = await this.db
      .prepare(
        'SELECT content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, 'prompt-action-' + nonce)
      .first<string>('content_hash');
    if (savedIntent !== intentHash) throw new Error('IDEMPOTENCY_CONFLICT');
    const saved = await this.db
      .prepare(
        'SELECT content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=?',
      )
      .bind(this.context.ownerId, key, generation)
      .first<string>('content_hash');
    if (saved !== pointerHash) throw new Error('REGISTRY_GENERATION_CONFLICT');
    return {
      generation,
      prompt_id: value.prompt_id,
      version: value.prompt_version,
      new_model_requests: 0,
      reprocess_jobs: 0,
      selection_effect: 'NONE',
    };
  }
}
