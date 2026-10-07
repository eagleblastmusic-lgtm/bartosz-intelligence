import { sha256 } from '../auth/crypto.js';
import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { familySchemas } from './bundle.js';
import { promptPointerKey } from './store.js';
import { PromptUsage } from './usage.js';
interface VersionRow {
  prompt_id: string;
  version: number;
  prompt_hash: string;
  status: 'DRAFT' | 'TESTED' | 'PUBLISHED';
  created_at: string;
  bundle_json: string;
  new_use_allowed: number;
}
export class PromptHistory {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async page(id: string, before: number | null = null) {
    this.context.requireOwner();
    if (
      !familySchemas[id] ||
      (before !== null && (!Number.isSafeInteger(before) || before < 1))
    )
      throw new Error('INVALID_PROMPT_HISTORY');
    const rows = await this.db
      .prepare(
        "SELECT p.prompt_id,p.version,p.prompt_hash,p.status,p.created_at,p.bundle_json,NOT EXISTS(SELECT 1 FROM config_versions c WHERE c.owner_id=p.owner_id AND c.config_id='prompt-disallowed-'||p.prompt_id||'-'||p.version AND c.revision=1) new_use_allowed FROM prompt_versions p WHERE p.owner_id=? AND p.prompt_id=? AND (? IS NULL OR p.version<?) ORDER BY p.version DESC LIMIT 51",
      )
      .bind(this.context.ownerId, id, before, before)
      .all<VersionRow>();
    const versions = rows.results
      .slice(0, 50)
      .map(({ bundle_json, new_use_allowed, ...row }) => ({
        ...row,
        new_use_allowed: Boolean(new_use_allowed),
        compatibility: JSON.parse(bundle_json) as Record<string, unknown>,
      }));
    return {
      versions,
      next_before: rows.results.length > 50 ? versions.at(-1)!.version : null,
    };
  }
  async active(id: string) {
    this.context.requireOwner();
    if (!familySchemas[id]) throw new Error('INVALID_PROMPT_FAMILY');
    const pointer = await this.db
      .prepare(
        'SELECT revision,payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id=? ORDER BY revision DESC LIMIT 1',
      )
      .bind(this.context.ownerId, promptPointerKey(id))
      .first<{
        revision: number;
        payload_json: string;
        content_hash: string;
      }>();
    let version: number,
      hash: string,
      generation = 0;
    if (pointer) {
      if ((await sha256(pointer.payload_json)) !== pointer.content_hash)
        throw new Error('REGISTRY_HASH_MISMATCH');
      const value = JSON.parse(pointer.payload_json) as {
        prompt_id: string;
        version: number;
        prompt_hash: string;
      };
      if (
        value.prompt_id !== id ||
        !Number.isSafeInteger(value.version) ||
        value.version < 1
      )
        throw new Error('REGISTRY_HASH_MISMATCH');
      version = value.version;
      hash = value.prompt_hash;
      generation = pointer.revision;
      const target = await this.db
        .prepare(
          "SELECT prompt_hash FROM prompt_versions WHERE owner_id=? AND prompt_id=? AND version=? AND status='PUBLISHED'",
        )
        .bind(this.context.ownerId, id, version)
        .first<string>('prompt_hash');
      if (target !== hash) throw new Error('REGISTRY_HASH_MISMATCH');
    } else {
      const published = await this.db
        .prepare(
          "SELECT version,prompt_hash FROM prompt_versions WHERE owner_id=? AND prompt_id=? AND status='PUBLISHED' ORDER BY version DESC LIMIT 1",
        )
        .bind(this.context.ownerId, id)
        .first<{ version: number; prompt_hash: string }>();
      if (!published) return null;
      version = published.version;
      hash = published.prompt_hash;
    }
    const restriction = await new PromptUsage(this.db, this.context).status(
      id,
      version,
    );
    if (restriction && restriction.prompt_hash !== hash)
      throw new Error('REGISTRY_HASH_MISMATCH');
    return {
      version,
      prompt_hash: hash,
      generation,
      new_use_allowed: !restriction,
    };
  }
}
