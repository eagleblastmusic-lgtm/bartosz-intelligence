import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { sha256 } from '../auth/crypto.js';
import { compileSemanticProfile } from '../ai/semantic-profile.js';
import type { RegistryBundle } from './bundle.js';
import { PromptRegistry } from './store.js';
import type { PromptSnapshot } from './store.js';

export type MaterializedSemanticProfile = Awaited<
  ReturnType<typeof compileSemanticProfile>
>;
export interface SemanticProfileSnapshot {
  profile_id: string;
  revision: number;
  name: string;
  compiled: MaterializedSemanticProfile;
}
export interface SemanticProfileAssignment {
  profile_id: string;
  revision: number;
  source_id: string | null;
  effective_from: string;
  apply_to_pending: boolean;
  reason: string;
}
export function semanticPrompt(
  snapshot: SemanticProfileSnapshot,
  registered?: PromptSnapshot,
): PromptSnapshot {
  const compiled = snapshot.compiled;
  if (registered) {
    if (
      registered.prompt_id !== compiled.prompt.id ||
      registered.wire.hash !== compiled.base_wire_hash ||
      registered.canonical.hash !== compiled.canonical.hash ||
      registered.enrichment_version !== compiled.enrichment_version
    )
      throw new Error('INCOMPATIBLE_PROMPT_SNAPSHOT');
    return { ...registered, wire: structuredClone(compiled.wire) };
  }
  return {
    prompt_id: compiled.prompt.id,
    version: compiled.prompt.version,
    prompt_hash: compiled.prompt.hash,
    text: compiled.prompt.text,
    wire: structuredClone(compiled.wire),
    canonical: {
      id: compiled.canonical.id,
      hash: compiled.canonical.hash,
      schema: structuredClone(compiled.canonical.schema),
    },
    enrichment_version: compiled.enrichment_version,
    generation: snapshot.revision,
  };
}
/** Semantic scope revisions are independent of ModelRegistry's provider revisions. */
export class SemanticProfiles {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async save(
    input: {
      profile_id: string;
      revision: number;
      name: string;
      config: unknown;
      reason: string;
    },
    bundle: RegistryBundle,
    now: Date,
  ) {
    this.context.requireOwner();
    if (
      !/^[a-zA-Z0-9_-]{1,80}$/.test(input.profile_id) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 120 ||
      typeof input.reason !== 'string' ||
      !input.reason.trim() ||
      input.reason.length > 1000
    )
      throw new Error('INVALID_SEMANTIC_PROFILE_REVISION');
    const compiled = await compileSemanticProfile(input.config, bundle);
    const snapshot: SemanticProfileSnapshot = {
      profile_id: input.profile_id,
      revision: input.revision,
      name: input.name.trim(),
      compiled,
    };
    const text = JSON.stringify(snapshot),
      hash = await sha256(text);
    const prior = await this.db
      .prepare(
        'SELECT snapshot_hash,reason FROM semantic_profile_versions WHERE owner_id=? AND profile_id=? AND revision=?',
      )
      .bind(this.context.ownerId, input.profile_id, input.revision)
      .first<{ snapshot_hash: string; reason: string }>();
    if (prior) {
      if (prior.snapshot_hash !== hash || prior.reason !== input.reason.trim())
        throw new Error('IMMUTABLE_SEMANTIC_PROFILE_CONFLICT');
      return snapshot;
    }
    await new PromptRegistry(this.db, this.context).importBundle(bundle, now);
    const wire = compiled.wire;
    const existing = await this.db
      .prepare(
        'SELECT schema_hash FROM schema_versions WHERE schema_id=? AND version=?',
      )
      .bind(wire.id, '1.0')
      .first<{ schema_hash: string }>();
    if (existing && existing.schema_hash !== wire.hash)
      throw new Error('IMMUTABLE_SCHEMA_CONFLICT');
    const results = await this.db.batch([
      this.db
        .prepare(
          'INSERT INTO schema_versions VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
        )
        .bind(
          wire.id,
          '1.0',
          wire.hash,
          JSON.stringify(wire.schema),
          now.toISOString(),
        ),
      this.db
        .prepare(
          `INSERT INTO semantic_profile_versions SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
        WHERE (SELECT COALESCE(MAX(revision),0) FROM semantic_profile_versions WHERE owner_id=? AND profile_id=?)=? RETURNING revision`,
        )
        .bind(
          this.context.ownerId,
          input.profile_id,
          input.revision,
          snapshot.name,
          JSON.stringify(compiled.config),
          compiled.config_hash,
          wire.id,
          '1.0',
          compiled.prompt.id,
          compiled.prompt.version,
          text,
          hash,
          this.context.actorId,
          input.reason.trim(),
          now.toISOString(),
          this.context.ownerId,
          input.profile_id,
          input.revision - 1,
        ),
    ]);
    if (!results[1]?.results?.length)
      throw new Error('SEMANTIC_PROFILE_REVISION_CONFLICT');
    return snapshot;
  }
  async load(
    profileId: string,
    revision: number,
  ): Promise<SemanticProfileSnapshot | null> {
    if (this.context.kind === 'owner') this.context.requireOwner();
    else this.context.requireTask('ANALYZE');
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new Error('INVALID_SEMANTIC_PROFILE_REVISION');
    const row = await this.db
      .prepare(
        'SELECT snapshot_json,snapshot_hash FROM semantic_profile_versions WHERE owner_id=? AND profile_id=? AND revision=?',
      )
      .bind(this.context.ownerId, profileId, revision)
      .first<{ snapshot_json: string; snapshot_hash: string }>();
    if (!row) return null;
    if ((await sha256(row.snapshot_json)) !== row.snapshot_hash)
      throw new Error('SEMANTIC_PROFILE_SNAPSHOT_HASH_MISMATCH');
    const snapshot = JSON.parse(row.snapshot_json) as SemanticProfileSnapshot;
    if (
      snapshot.profile_id !== profileId ||
      snapshot.revision !== revision ||
      (await sha256(JSON.stringify(snapshot.compiled.wire.schema))) !==
        snapshot.compiled.wire.hash ||
      (await sha256(snapshot.compiled.prompt.text)) !==
        snapshot.compiled.prompt.hash ||
      (await sha256(JSON.stringify(snapshot.compiled.config))) !==
        snapshot.compiled.config_hash
    )
      throw new Error('SEMANTIC_PROFILE_SNAPSHOT_HASH_MISMATCH');
    return snapshot;
  }
  async list() {
    this.context.requireOwner();
    const rows = await this.db
      .prepare(
        `SELECT profile_id,revision,name,config_json,config_hash,wire_schema_id,prompt_id,prompt_version,created_at
      FROM semantic_profile_versions WHERE owner_id=? ORDER BY profile_id,revision DESC LIMIT 201`,
      )
      .bind(this.context.ownerId)
      .all<Record<string, unknown>>();
    return {
      profiles: rows.results.slice(0, 200),
      has_more: rows.results.length > 200,
    };
  }
  async assign(
    input: SemanticProfileAssignment,
    expectedGeneration: number,
    now: Date,
  ) {
    this.context.requireOwner();
    if (
      !Number.isSafeInteger(expectedGeneration) ||
      expectedGeneration < 0 ||
      typeof input.apply_to_pending !== 'boolean' ||
      typeof input.reason !== 'string' ||
      !input.reason.trim() ||
      input.reason.length > 1000 ||
      !Number.isFinite(Date.parse(input.effective_from)) ||
      new Date(input.effective_from).toISOString() !== input.effective_from ||
      (input.source_id !== null &&
        (typeof input.source_id !== 'string' ||
          !input.source_id ||
          input.source_id.length > 128))
    )
      throw new Error('INVALID_PROFILE_ASSIGNMENT');
    const snapshot = await this.load(input.profile_id, input.revision);
    if (!snapshot) throw new Error('NOT_FOUND');
    // Only adapters that actually exist can be activated. Drafts remain editable.
    const config = snapshot.compiled.config;
    if (
      config.translation !== 'NONE' ||
      config.history ||
      config.second_pass ||
      config.validation_pass
    )
      throw new Error('CAPABILITY_NOT_AVAILABLE');
    if (
      input.source_id !== null &&
      !(await this.db
        .prepare('SELECT 1 FROM sources WHERE owner_id=? AND source_id=?')
        .bind(this.context.ownerId, input.source_id)
        .first())
    )
      throw new Error('NOT_FOUND');
    const id = 'semantic-profile-' + (input.source_id ?? 'default');
    const text = JSON.stringify({
      ...input,
      reason: input.reason.trim(),
      authored_by: this.context.actorId,
    });
    const hash = await sha256(text);
    const current = await this.db
      .prepare(
        'SELECT revision,content_hash FROM config_versions WHERE owner_id=? AND config_id=? ORDER BY revision DESC LIMIT 1',
      )
      .bind(this.context.ownerId, id)
      .first<{ revision: number; content_hash: string }>();
    if (
      current?.revision === expectedGeneration + 1 &&
      current.content_hash === hash
    )
      return { generation: current.revision, assignment: input };
    const result = await this.db
      .prepare(
        `INSERT INTO config_versions(config_id,owner_id,revision,payload_json,content_hash,created_at)
      SELECT ?,?,?,?,?,? WHERE (SELECT COALESCE(MAX(revision),0) FROM config_versions WHERE owner_id=? AND config_id=?)=? RETURNING revision`,
      )
      .bind(
        id,
        this.context.ownerId,
        expectedGeneration + 1,
        text,
        hash,
        now.toISOString(),
        this.context.ownerId,
        id,
        expectedGeneration,
      )
      .all<{ revision: number }>();
    if (!result.results.length)
      throw new Error('SEMANTIC_PROFILE_REVISION_CONFLICT');
    return { generation: expectedGeneration + 1, assignment: input };
  }
  async assignments() {
    this.context.requireOwner();
    const rows = (
      await this.db
        .prepare(
          `SELECT config_id,revision,payload_json FROM config_versions c WHERE owner_id=? AND config_id LIKE 'semantic-profile-%'
      AND revision=(SELECT MAX(revision) FROM config_versions x WHERE x.owner_id=c.owner_id AND x.config_id=c.config_id) ORDER BY config_id LIMIT 201`,
        )
        .bind(this.context.ownerId)
        .all<{ config_id: string; revision: number; payload_json: string }>()
    ).results;
    return {
      assignments: rows.slice(0, 200).map((row) => ({
        generation: row.revision,
        ...(JSON.parse(row.payload_json) as SemanticProfileAssignment),
      })),
      has_more: rows.length > 200,
    };
  }
  async forItem(
    itemId: string,
    now: Date,
  ): Promise<SemanticProfileSnapshot | null> {
    if (this.context.kind === 'owner') this.context.requireOwner();
    else this.context.requireTask('ANALYZE');
    const item = await this.db
      .prepare(
        `SELECT source_id,discovered_at,EXISTS(SELECT 1 FROM jobs j WHERE j.owner_id=i.owner_id AND j.item_id=i.item_id AND j.task_type='ANALYZE') AS pinned
      FROM items i WHERE owner_id=? AND item_id=?`,
      )
      .bind(this.context.ownerId, itemId)
      .first<{ source_id: string; discovered_at: string; pinned: number }>();
    if (!item) throw new Error('NOT_FOUND');
    if (item.pinned) {
      const job = await this.db
        .prepare(
          "SELECT payload_json,profile_revision FROM jobs WHERE owner_id=? AND item_id=? AND task_type='ANALYZE' AND COALESCE(reason_code,'')<>'PROFILE_SUPERSEDED' ORDER BY created_at DESC,job_id DESC LIMIT 1",
        )
        .bind(this.context.ownerId, itemId)
        .first<{ payload_json: string; profile_revision: string }>();
      if (!job) throw new Error('SEMANTIC_PROFILE_SNAPSHOT_HASH_MISMATCH');
      const snapshot = (
        JSON.parse(job.payload_json) as {
          snapshot: { semantic_profile?: SemanticProfileSnapshot };
        }
      ).snapshot;
      if ((await sha256(JSON.stringify(snapshot))) !== job.profile_revision)
        throw new Error('SEMANTIC_PROFILE_SNAPSHOT_HASH_MISMATCH');
      if (!snapshot.semantic_profile) return null;
      const pinned = await this.load(
        snapshot.semantic_profile.profile_id,
        snapshot.semantic_profile.revision,
      );
      if (JSON.stringify(pinned) !== JSON.stringify(snapshot.semantic_profile))
        throw new Error('SEMANTIC_PROFILE_SNAPSHOT_HASH_MISMATCH');
      return pinned;
    }
    // Channel-specific assignments take priority; otherwise use the default.
    // Pending means a material without a durable analysis snapshot. Already pinned jobs never change here.
    const row = await this.db
      .prepare(
        `SELECT payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id IN (?, 'semantic-profile-default')
      AND json_extract(payload_json,'$.effective_from')<=?
      AND ((json_extract(payload_json,'$.effective_from')<=? AND created_at<=?) OR (?=0 AND json_extract(payload_json,'$.apply_to_pending')=1))
      ORDER BY (config_id=?) DESC,revision DESC LIMIT 1`,
      )
      .bind(
        this.context.ownerId,
        'semantic-profile-' + item.source_id,
        now.toISOString(),
        item.discovered_at,
        item.discovered_at,
        item.pinned,
        'semantic-profile-' + item.source_id,
      )
      .first<{ payload_json: string; content_hash: string }>();
    if (!row) return null;
    if ((await sha256(row.payload_json)) !== row.content_hash)
      throw new Error('SEMANTIC_PROFILE_SNAPSHOT_HASH_MISMATCH');
    const assignment = JSON.parse(
      row.payload_json,
    ) as SemanticProfileAssignment;
    const snapshot = await this.load(
      assignment.profile_id,
      assignment.revision,
    );
    if (!snapshot) throw new Error('SEMANTIC_PROFILE_SNAPSHOT_HASH_MISMATCH');
    return snapshot;
  }
}
