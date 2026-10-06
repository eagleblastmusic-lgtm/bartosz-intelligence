import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
import type { PipelineProfile } from '../../../contracts/src/ai.js';
export class ModelRegistry {
  constructor(
    private db: Database,
    private context: AccessContext,
    private task: 'ANALYZE' | 'TRANSLATE' | 'HISTORICAL_COMPARE' = 'ANALYZE',
  ) {
    assertContext(context);
  }
  async publish(profile: PipelineProfile, now: Date) {
    this.context.requireOwner();
    if (
      profile.profile_id !== 'gemini_free' ||
      profile.provider_id !== 'gemini' ||
      !profile.free_eligible ||
      profile.billing_enabled ||
      !profile.account_key ||
      !Number.isSafeInteger(profile.revision) ||
      profile.revision < 1 ||
      !Number.isFinite(Date.parse(profile.eligibility_expires_at))
    )
      throw new Error('UNQUALIFIED_PROFILE');
    const text = JSON.stringify(profile),
      hash = await sha256(text);
    const existing = await this.db
      .prepare(
        'SELECT content_hash FROM model_registry WHERE owner_id=? AND profile_id=? AND revision=?',
      )
      .bind(this.context.ownerId, profile.profile_id, profile.revision)
      .first<{ content_hash: string }>();
    if (existing && existing.content_hash !== hash)
      throw new Error('IMMUTABLE_MODEL_CONFLICT');
    await this.db
      .prepare(
        'INSERT INTO model_registry VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
      )
      .bind(
        this.context.ownerId,
        profile.profile_id,
        profile.revision,
        text,
        hash,
        now.toISOString(),
      )
      .run();
  }
  async latest(profileId: string) {
    return this.read(profileId, null);
  }
  async load(profileId: string, revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new Error('INVALID_MODEL_REVISION');
    return this.read(profileId, revision);
  }
  private async read(profileId: string, revision: number | null) {
    if (this.context.kind === 'owner') this.context.requireOwner();
    else this.context.requireTask(this.task);
    const row = await this.db
      .prepare(
        'SELECT content_hash,snapshot_json FROM model_registry WHERE owner_id=? AND profile_id=? AND (? IS NULL OR revision=?) ORDER BY revision DESC LIMIT 1',
      )
      .bind(this.context.ownerId, profileId, revision, revision)
      .first<{ content_hash: string; snapshot_json: string }>();
    if (!row) return null;
    if ((await sha256(row.snapshot_json)) !== row.content_hash)
      throw new Error('MODEL_SNAPSHOT_HASH_MISMATCH');
    return JSON.parse(row.snapshot_json) as PipelineProfile;
  }
}
