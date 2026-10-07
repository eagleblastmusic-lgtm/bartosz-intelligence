import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
import { PromptUsage } from './usage.js';
import {
  familySchemas,
  verifyRegistryBundle,
  type RegistryBundle,
  type JsonSchema,
} from './bundle.js';
export interface PromptSnapshot {
  prompt_id: string;
  version: number;
  prompt_hash: string;
  text: string;
  wire: { id: string; hash: string; schema: JsonSchema };
  canonical: { id: string; hash: string; schema: JsonSchema };
  enrichment_version: '1.0';
  generation: number;
}
export const promptPointerKey = (family: string) =>
  family === 'ECONOMY_ANALYSIS_V1'
    ? 'active-economy-prompt'
    : 'active-prompt-' + family;
export class PromptRegistry {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async importBundle(bundle: RegistryBundle, now: Date) {
    this.context.requireOwner();
    const bundleHash = await verifyRegistryBundle(bundle);
    const statements = [];
    for (const row of bundle.schemas) {
      const existing = await this.db
        .prepare(
          'SELECT schema_hash FROM schema_versions WHERE schema_id=? AND version=?',
        )
        .bind(row.id, row.version)
        .first<{ schema_hash: string }>();
      if (existing && existing.schema_hash !== row.hash)
        throw new Error('IMMUTABLE_SCHEMA_CONFLICT');
      statements.push(
        this.db
          .prepare(
            'INSERT INTO schema_versions VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
          )
          .bind(
            row.id,
            row.version,
            row.hash,
            JSON.stringify(row.schema),
            now.toISOString(),
          ),
      );
    }
    for (const row of bundle.prompts) {
      const pair = familySchemas[row.id]!;
      const compatibility = JSON.stringify({
        wire_schema_id: 'urn:bartosz:schema:' + pair[0],
        canonical_schema_id: 'urn:bartosz:schema:' + pair[1],
        enrichment_version: '1.0',
        master_sha256: bundle.master_sha256,
        bundle_hash: bundleHash,
      });
      const existing = await this.db
        .prepare(
          'SELECT prompt_hash,bundle_json FROM prompt_versions WHERE owner_id=? AND prompt_id=? AND version=?',
        )
        .bind(this.context.ownerId, row.id, row.version)
        .first<{ prompt_hash: string; bundle_json: string }>();
      if (
        existing &&
        (existing.prompt_hash !== row.hash ||
          existing.bundle_json !== compatibility)
      )
        throw new Error('IMMUTABLE_PROMPT_CONFLICT');
      statements.push(
        this.db
          .prepare(
            'INSERT INTO prompt_versions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
          )
          .bind(
            row.id,
            this.context.ownerId,
            row.version,
            row.hash,
            row.text,
            compatibility,
            row.id === 'ECONOMY_ANALYSIS_V1' || row.id === 'JSON_REPAIR_V1'
              ? 'PUBLISHED'
              : 'DRAFT',
            now.toISOString(),
          ),
      );
    }
    await this.db.batch(statements);
    return bundleHash;
  }
  async activate(
    promptId: string,
    version: number,
    expectedGeneration: number,
    now: Date,
  ) {
    this.context.requireOwner();
    if (
      promptId !== 'ECONOMY_ANALYSIS_V1' ||
      !Number.isSafeInteger(expectedGeneration) ||
      expectedGeneration < 0
    )
      throw new Error('INVALID_REGISTRY_POINTER');
    const snapshot = await this.load(promptId, version, expectedGeneration);
    await new PromptUsage(this.db, this.context).requireNewUse(
      promptId,
      version,
    );
    const payload = JSON.stringify({
        prompt_id: promptId,
        version,
        prompt_hash: snapshot.prompt_hash,
      }),
      hash = await sha256(payload);
    const result = await this.db
      .prepare(
        `INSERT INTO config_versions(config_id,owner_id,revision,payload_json,content_hash,created_at) SELECT 'active-economy-prompt',?,?,?,?,? WHERE (SELECT COALESCE(MAX(revision),0) FROM config_versions WHERE owner_id=? AND config_id='active-economy-prompt')=? AND NOT EXISTS(SELECT 1 FROM config_versions WHERE owner_id=? AND config_id=? AND revision=1)`,
      )
      .bind(
        this.context.ownerId,
        expectedGeneration + 1,
        payload,
        hash,
        now.toISOString(),
        this.context.ownerId,
        expectedGeneration,
        this.context.ownerId,
        'prompt-disallowed-' + promptId + '-' + version,
      )
      .run();
    if (result.meta.changes !== 1)
      throw new Error('REGISTRY_GENERATION_CONFLICT');
    return expectedGeneration + 1;
  }
  async current() {
    if (this.context.kind === 'owner') this.context.requireOwner();
    else this.context.requireTask('ANALYZE');
    const row = await this.db
      .prepare(
        "SELECT revision,payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id='active-economy-prompt' ORDER BY revision DESC LIMIT 1",
      )
      .bind(this.context.ownerId)
      .first<{
        revision: number;
        payload_json: string;
        content_hash: string;
      }>();
    if (!row) throw new Error('PROMPT_NOT_CONFIGURED');
    if ((await sha256(row.payload_json)) !== row.content_hash)
      throw new Error('REGISTRY_HASH_MISMATCH');
    const pointer = JSON.parse(row.payload_json) as {
      prompt_id: string;
      version: number;
      prompt_hash: string;
    };
    const snapshot = await this.load(
      pointer.prompt_id,
      pointer.version,
      row.revision,
    );
    if (
      pointer.prompt_id !== 'ECONOMY_ANALYSIS_V1' ||
      snapshot.prompt_hash !== pointer.prompt_hash
    )
      throw new Error('REGISTRY_HASH_MISMATCH');
    await new PromptUsage(this.db, this.context).requireNewUse(
      snapshot.prompt_id,
      snapshot.version,
    );
    return snapshot;
  }
  async currentFamily(family: string, inspectDisallowed = false) {
    if (!familySchemas[family]) throw new Error('INVALID_PROMPT_FAMILY');
    if (this.context.kind === 'owner') this.context.requireOwner();
    else this.context.requireTask('ANALYZE');
    if (inspectDisallowed) this.context.requireOwner();
    const pointer = await this.db
      .prepare(
        'SELECT revision,payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id=? ORDER BY revision DESC LIMIT 1',
      )
      .bind(this.context.ownerId, promptPointerKey(family))
      .first<{
        revision: number;
        payload_json: string;
        content_hash: string;
      }>();
    if (pointer) {
      if ((await sha256(pointer.payload_json)) !== pointer.content_hash)
        throw new Error('REGISTRY_HASH_MISMATCH');
      const value = JSON.parse(pointer.payload_json) as {
        prompt_id: string;
        version: number;
        prompt_hash: string;
      };
      if (value.prompt_id !== family) throw new Error('REGISTRY_HASH_MISMATCH');
      const snapshot = await this.load(family, value.version, pointer.revision);
      if (snapshot.prompt_hash !== value.prompt_hash)
        throw new Error('REGISTRY_HASH_MISMATCH');
      if (!inspectDisallowed)
        await new PromptUsage(this.db, this.context).requireNewUse(
          family,
          snapshot.version,
        );
      return snapshot;
    }
    // Existing registries predate family pointers. Resolve only an actually
    // published database version; never fall back to bundled prompt text.
    const existing = await this.db
      .prepare(
        "SELECT version FROM prompt_versions WHERE owner_id=? AND prompt_id=? AND status='PUBLISHED' ORDER BY version DESC LIMIT 1",
      )
      .bind(this.context.ownerId, family)
      .first<{ version: number }>();
    if (!existing) throw new Error('PROMPT_NOT_CONFIGURED');
    if (!inspectDisallowed)
      await new PromptUsage(this.db, this.context).requireNewUse(
        family,
        existing.version,
      );
    return this.load(family, existing.version, 0);
  }
  async load(
    promptId: string,
    version: number,
    generation: number,
    mode: 'PRODUCTION' | 'QUALITY_TEST' = 'PRODUCTION',
  ): Promise<PromptSnapshot> {
    if (this.context.kind === 'owner') this.context.requireOwner();
    else this.context.requireTask('ANALYZE');
    if (!['PRODUCTION', 'QUALITY_TEST'].includes(mode))
      throw new Error('INVALID_PROMPT_MODE');
    const row = await this.db
      .prepare(
        "SELECT prompt_hash,prompt_text,bundle_json FROM prompt_versions WHERE owner_id=? AND prompt_id=? AND version=? AND (status='PUBLISHED' OR (?='QUALITY_TEST' AND status IN ('DRAFT','TESTED')))",
      )
      .bind(this.context.ownerId, promptId, version, mode)
      .first<{
        prompt_hash: string;
        prompt_text: string;
        bundle_json: string;
      }>();
    if (!row || (await sha256(row.prompt_text)) !== row.prompt_hash)
      throw new Error('PROMPT_NOT_AVAILABLE');
    const compatibility = JSON.parse(row.bundle_json) as {
      wire_schema_id: string;
      canonical_schema_id: string;
      enrichment_version: string;
    };
    const expected = familySchemas[promptId];
    if (
      !expected ||
      compatibility.wire_schema_id !== 'urn:bartosz:schema:' + expected[0] ||
      compatibility.canonical_schema_id !==
        'urn:bartosz:schema:' + expected[1] ||
      compatibility.enrichment_version !== '1.0'
    )
      throw new Error('INCOMPATIBLE_BUNDLE');
    const schema = async (id: string) => {
      const result = await this.db
        .prepare(
          'SELECT schema_hash,schema_json FROM schema_versions WHERE schema_id=? AND version=?',
        )
        .bind(id, id.split(':').at(-1)!)
        .first<{ schema_hash: string; schema_json: string }>();
      if (!result || (await sha256(result.schema_json)) !== result.schema_hash)
        throw new Error('SCHEMA_HASH_MISMATCH');
      return {
        id,
        hash: result.schema_hash,
        schema: JSON.parse(result.schema_json) as JsonSchema,
      };
    };
    return {
      prompt_id: promptId,
      version,
      prompt_hash: row.prompt_hash,
      text: row.prompt_text,
      wire: await schema(compatibility.wire_schema_id),
      canonical: await schema(compatibility.canonical_schema_id),
      enrichment_version: '1.0',
      generation,
    };
  }
}
