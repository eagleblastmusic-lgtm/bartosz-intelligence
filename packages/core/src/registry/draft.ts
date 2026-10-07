import { sha256 } from '../auth/crypto.js';
import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { familySchemas } from './bundle.js';
import { validator_schema_hashes } from './generated/validators.js';
import { PromptUsage } from './usage.js';

interface PromptVersion {
  prompt_id: string;
  version: number;
  prompt_hash: string;
  prompt_text: string;
  bundle_json: string;
  status: 'DRAFT' | 'TESTED' | 'PUBLISHED';
  created_at: string;
}
const inputs = (text: string) =>
  [
    ...new Set(
      [...text.matchAll(/\{\{([a-z_]+)\}\}/g)].map((match) => match[1]!),
    ),
  ].sort();

/** Editing creates a new version; draft text is never an executable published pointer. */
export class PromptDrafts {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async families() {
    this.context.requireOwner();
    const rows = await this.db
      .prepare(
        'SELECT prompt_id,version,prompt_hash,status,created_at,bundle_json FROM prompt_versions WHERE owner_id=? ORDER BY prompt_id,version DESC',
      )
      .bind(this.context.ownerId)
      .all<Omit<PromptVersion, 'prompt_text'>>();
    return Object.entries(familySchemas).map(
      ([prompt_id, [wire, canonical]]) => ({
        prompt_id,
        wire_schema_id: 'urn:bartosz:schema:' + wire,
        canonical_schema_id: 'urn:bartosz:schema:' + canonical,
        versions: rows.results
          .filter((row) => row.prompt_id === prompt_id)
          .map(({ bundle_json, ...row }) => ({
            ...row,
            compatibility: JSON.parse(bundle_json) as Record<string, unknown>,
          })),
      }),
    );
  }
  async version(promptId: string, version: number) {
    this.context.requireOwner();
    if (
      !familySchemas[promptId] ||
      !Number.isSafeInteger(version) ||
      version < 1
    )
      throw new Error('INVALID_PROMPT_VERSION');
    const row = await this.db
      .prepare(
        'SELECT prompt_id,version,prompt_hash,prompt_text,bundle_json,status,created_at FROM prompt_versions WHERE owner_id=? AND prompt_id=? AND version=?',
      )
      .bind(this.context.ownerId, promptId, version)
      .first<PromptVersion>();
    if (!row) throw new Error('NOT_FOUND');
    if ((await sha256(row.prompt_text)) !== row.prompt_hash)
      throw new Error('REGISTRY_HASH_MISMATCH');
    const compatibility = JSON.parse(row.bundle_json) as {
      wire_schema_id: string;
      canonical_schema_id: string;
      enrichment_version: string;
    };
    const pair = familySchemas[promptId]!;
    if (
      compatibility.wire_schema_id !== 'urn:bartosz:schema:' + pair[0] ||
      compatibility.canonical_schema_id !== 'urn:bartosz:schema:' + pair[1] ||
      compatibility.enrichment_version !== '1.0'
    )
      throw new Error('INCOMPATIBLE_BUNDLE');
    for (const id of [
      compatibility.wire_schema_id,
      compatibility.canonical_schema_id,
    ]) {
      const schema = await this.db
        .prepare(
          'SELECT schema_hash,schema_json FROM schema_versions WHERE schema_id=? AND version=?',
        )
        .bind(id, id.split(':').at(-1)!)
        .first<{ schema_hash: string; schema_json: string }>();
      if (
        !schema ||
        (await sha256(schema.schema_json)) !== schema.schema_hash ||
        schema.schema_hash !==
          (validator_schema_hashes as Record<string, string>)[id]
      )
        throw new Error('INCOMPATIBLE_BUNDLE');
    }
    return {
      ...row,
      required_inputs: inputs(row.prompt_text),
      compatibility,
      usage_restriction: await new PromptUsage(this.db, this.context).status(
        promptId,
        version,
      ),
    };
  }
  async create(
    input: {
      prompt_id: string;
      base_version: number;
      expected_latest_version: number;
      text: string;
      reason: string;
    },
    now: Date,
  ) {
    this.context.requireOwner();
    if (
      !Number.isSafeInteger(input.expected_latest_version) ||
      input.expected_latest_version < input.base_version ||
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      new TextEncoder().encode(input.text).length > 120000 ||
      typeof input.reason !== 'string' ||
      !input.reason.trim() ||
      input.reason.length > 1000 ||
      !Number.isFinite(now.getTime())
    )
      throw new Error('INVALID_PROMPT_DRAFT');
    const base = await this.version(input.prompt_id, input.base_version);
    if (
      JSON.stringify(inputs(input.text)) !==
      JSON.stringify(base.required_inputs)
    )
      throw new Error('INVALID_PROMPT_INPUTS');
    const hash = await sha256(input.text);
    if (hash === base.prompt_hash) throw new Error('INVALID_UNCHANGED_PROMPT');
    const version = input.expected_latest_version + 1;
    const compatibility = {
      ...(JSON.parse(base.bundle_json) as Record<string, unknown>),
      draft_metadata: {
        base_version: base.version,
        base_hash: base.prompt_hash,
        created_by: this.context.actorId,
        reason: input.reason.trim(),
        required_inputs: base.required_inputs,
      },
    };
    const eventId = crypto.randomUUID();
    const result = await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO prompt_versions(prompt_id,owner_id,version,prompt_hash,prompt_text,bundle_json,status,created_at) SELECT ?,?,?,?,?,?,'DRAFT',? WHERE (SELECT COALESCE(MAX(version),0) FROM prompt_versions WHERE owner_id=? AND prompt_id=?)=? ON CONFLICT DO NOTHING",
        )
        .bind(
          input.prompt_id,
          this.context.ownerId,
          version,
          hash,
          input.text,
          JSON.stringify(compatibility),
          now.toISOString(),
          this.context.ownerId,
          input.prompt_id,
          input.expected_latest_version,
        ),
      this.db
        .prepare(
          "INSERT INTO audit_events(event_id,owner_id,actor_id,event_type,target_id,correlation_id,created_at) SELECT ?,?,?,'PROMPT_DRAFT_CREATED',?,?,? WHERE changes()=1",
        )
        .bind(
          eventId,
          this.context.ownerId,
          this.context.actorId,
          input.prompt_id + ':' + version,
          hash,
          now.toISOString(),
        ),
    ]);
    if (result[0]?.meta.changes !== 1 || result[1]?.meta.changes !== 1) {
      const existing = await this.db
        .prepare(
          'SELECT prompt_hash,bundle_json FROM prompt_versions WHERE owner_id=? AND prompt_id=? AND version=?',
        )
        .bind(this.context.ownerId, input.prompt_id, version)
        .first<{ prompt_hash: string; bundle_json: string }>();
      if (
        !existing ||
        existing.prompt_hash !== hash ||
        existing.bundle_json !== JSON.stringify(compatibility)
      )
        throw new Error('REGISTRY_VERSION_CONFLICT');
    }
    return this.version(input.prompt_id, version);
  }
}
