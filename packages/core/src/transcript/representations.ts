import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { ArtifactRepository } from '../artifacts/store.js';
import { leasePredicate } from '../jobs/lease-guard.js';
import type { LeaseToken, TaskType } from '../../../contracts/src/jobs.js';
import type { LanguageSelection } from './language.js';

export class RepresentationRepository {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async record(
    artifactId: string,
    selection: LanguageSelection,
    role: 'SOURCE_AUTHORITY' | 'PL_HELPER',
    token: LeaseToken,
    task: TaskType,
    now: Date,
  ) {
    const track =
      role === 'SOURCE_AUTHORITY' ? selection.source : selection.helper_track;
    if (selection.status !== 'SELECTED' || !track)
      throw new Error('NO_SELECTED_TRACK');
    const artifact = await new ArtifactRepository(this.db, this.context).get(
      artifactId,
      token,
      task,
      now,
    );
    if (
      artifact.state !== 'VERIFIED' ||
      artifact.item_id !== track.item_id ||
      artifact.kind !==
        (role === 'SOURCE_AUTHORITY' ? 'SOURCE_ORIGINAL' : 'PL_HELPER')
    )
      throw new Error('INVALID_REPRESENTATION_SOURCE');
    if (role === 'PL_HELPER' && !artifact.original_ref)
      throw new Error('MISSING_HELPER_AUTHORITY');
    const authority =
      role === 'SOURCE_AUTHORITY'
        ? artifact
        : await new ArtifactRepository(this.db, this.context).get(
            artifact.original_ref!,
            token,
            task,
            now,
          );
    if (
      authority.kind !== 'SOURCE_ORIGINAL' ||
      authority.state !== 'VERIFIED' ||
      authority.content_hash !== selection.source_revision
    )
      throw new Error('REPRESENTATION_REVISION_MISMATCH');
    const provenance = JSON.parse(artifact.provenance_json) as Record<
      string,
      unknown
    >;
    if (
      typeof provenance.provider_id !== 'string' ||
      !provenance.provider_id ||
      provenance.upstream_track_id !== track.track_id
    )
      throw new Error('REPRESENTATION_PROVENANCE_MISMATCH');
    const flags = JSON.stringify({
      selection,
      selected_track_id: track.track_id,
    });
    if (new TextEncoder().encode(flags).length > 8000)
      throw new Error('REPRESENTATION_TOO_LARGE');
    const guard = leasePredicate(this.context, token, now.toISOString(), task);
    await this.db
      .prepare(
        `INSERT INTO transcript_representations(representation_id,owner_id,item_id,artifact_id,role,language_code,track_kind,provider_id,provider_version,normalizer_version,original_ref,flags_json,created_at)
      SELECT ?,?,?,?,?,?,?,?, ?,NULL,?,?,? WHERE ${guard.predicate}
      ON CONFLICT(owner_id,artifact_id,role) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        this.context.ownerId,
        artifact.item_id,
        artifactId,
        role,
        track.language_code,
        track.track_kind,
        provenance.provider_id,
        artifact.producer_version,
        artifact.original_ref,
        flags,
        now.toISOString(),
        ...guard.bindings,
      )
      .run();
    const row = await this.db
      .prepare(
        `SELECT representation_id,flags_json FROM transcript_representations WHERE owner_id=? AND artifact_id=? AND role=? AND ${guard.predicate}`,
      )
      .bind(this.context.ownerId, artifactId, role, ...guard.bindings)
      .first<{ representation_id: string; flags_json: string }>();
    if (!row) throw new Error('STALE_FENCE');
    if (row.flags_json !== flags) throw new Error('REPRESENTATION_CONFLICT');
    return row.representation_id;
  }
}
