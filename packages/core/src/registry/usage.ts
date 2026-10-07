import { sha256 } from '../auth/crypto.js';
import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { familySchemas } from './bundle.js';
export const promptUseKey = (id: string, version: number) =>
  'prompt-disallowed-' + id + '-' + version;
export const promptUseGuard = (owner: string, id: string, version: number) => ({
  predicate:
    'NOT EXISTS(SELECT 1 FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1)',
  bindings: [owner, promptUseKey(id, version)],
});
export class PromptUsage {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async status(id: string, version: number) {
    if (!familySchemas[id] || !Number.isSafeInteger(version) || version < 1)
      throw new Error('INVALID_PROMPT_VERSION');
    const row = await this.db
      .prepare(
        'SELECT payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1',
      )
      .bind(this.context.ownerId, promptUseKey(id, version))
      .first<{ payload_json: string; content_hash: string }>();
    if (!row) return null;
    if ((await sha256(row.payload_json)) !== row.content_hash)
      throw new Error('REGISTRY_HASH_MISMATCH');
    const value = JSON.parse(row.payload_json) as {
      version: string;
      prompt_id: string;
      prompt_version: number;
      prompt_hash: string;
      reason: string;
      created_by: string;
      created_at: string;
    };
    if (
      value.version !== 'prompt-use-restriction:1' ||
      value.prompt_id !== id ||
      value.prompt_version !== version
    )
      throw new Error('REGISTRY_HASH_MISMATCH');
    return { receipt_hash: row.content_hash, ...value };
  }
  async requireNewUse(id: string, version: number) {
    if (await this.status(id, version)) throw new Error('PROMPT_DEPRECATED');
  }
  async deprecate(
    id: string,
    version: number,
    expectedHash: string,
    reason: string,
    now: Date,
  ) {
    this.context.requireOwner();
    if (
      !familySchemas[id] ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !/^[a-f0-9]{64}$/.test(expectedHash) ||
      typeof reason !== 'string' ||
      !reason.trim() ||
      reason.length > 1000 ||
      !Number.isFinite(now.getTime())
    )
      throw new Error('INVALID_PROMPT_DEPRECATION');
    const row = await this.db
      .prepare(
        'SELECT prompt_hash,prompt_text FROM prompt_versions WHERE owner_id=? AND prompt_id=? AND version=?',
      )
      .bind(this.context.ownerId, id, version)
      .first<{ prompt_hash: string; prompt_text: string }>();
    if (!row) throw new Error('NOT_FOUND');
    if (
      row.prompt_hash !== expectedHash ||
      (await sha256(row.prompt_text)) !== expectedHash
    )
      throw new Error('REGISTRY_HASH_MISMATCH');
    const prior = await this.status(id, version);
    if (prior) return prior;
    const value = {
        version: 'prompt-use-restriction:1',
        prompt_id: id,
        prompt_version: version,
        prompt_hash: expectedHash,
        reason: reason.trim(),
        created_by: this.context.actorId,
        created_at: now.toISOString(),
      },
      serialized = JSON.stringify(value),
      hash = await sha256(serialized);
    await this.db.batch([
      this.db
        .prepare(
          'INSERT INTO config_versions VALUES(?,?,1,?,?,?) ON CONFLICT DO NOTHING',
        )
        .bind(
          promptUseKey(id, version),
          this.context.ownerId,
          serialized,
          hash,
          now.toISOString(),
        ),
      this.db
        .prepare(
          "INSERT INTO audit_events SELECT ?,?,?,'PROMPT_DEPRECATED',?,?,? WHERE changes()=1 ON CONFLICT DO NOTHING",
        )
        .bind(
          'prompt-deprecated-' +
            this.context.ownerId +
            '-' +
            id +
            '-' +
            version,
          this.context.ownerId,
          this.context.actorId,
          id + ':' + version,
          hash,
          now.toISOString(),
        ),
    ]);
    return this.status(id, version);
  }
}
