import type { AccessContext, Database } from '../db/boundary.js';
import { publicationDate } from '../projections/dates.js';
import type { TranscriptSourceCompletion } from '../transcript/acceptance.js';

/** Called inside the existing fenced source-acceptance batch. No AI, no extra
 * source bytes, no historical backfill and no enrollment of partial artifacts. */
export function dailyMaterialEffects(
  db: Database,
  context: AccessContext,
  input: TranscriptSourceCompletion,
  provenance: Record<string, unknown>,
  now: Date,
  guard: string,
  bindings: readonly (string | number | null)[],
) {
  const date = publicationDate(now.toISOString()),
    track = input.selection.source!;
  const descriptor = JSON.stringify({
    language_code: track.language_code,
    track_kind: track.track_kind,
    upstream_track_id: track.track_id,
    provider_id: provenance.provider_id,
    provider_version:
      provenance.provider_version ?? 'yt-dlp@2026.08.19+yt-dlp-ejs@0.8.0',
    source_status: provenance.archive_source_status ?? 'AVAILABLE_FULL',
    original_language_confirmed:
      input.selection.authority_confidence === 'CONFIRMED',
    retrieved_at: now.toISOString(),
    timestamp_precision: provenance.timestamp_precision ?? 'UNKNOWN',
    missing_ranges: provenance.missing_ranges ?? [],
    warnings: input.warnings,
  });
  return [
    db
      .prepare(
        `INSERT INTO daily_materials(owner_id,item_id,video_id,material_date,acquired_at,source_artifact_id,segment_map_artifact_id,source_hash,descriptor_json)
    SELECT i.owner_id,i.item_id,i.external_id,?,?,?,?,?,json_set(?,'$.video_id',i.external_id,'$.title',COALESCE(json_extract(m.metadata_json,'$.title'),''),'$.channel',COALESCE(c.title,''),'$.url',i.canonical_url,'$.published_at',i.published_at,'$.discovered_at',i.discovered_at)
    FROM items i JOIN item_revisions m ON m.owner_id=i.owner_id AND m.item_id=i.item_id AND m.revision_id=i.current_revision_id LEFT JOIN channels c ON c.owner_id=i.owner_id AND c.source_id=i.source_id
    WHERE i.owner_id=? AND i.item_id=? AND EXISTS(SELECT 1 FROM daily_workflow_settings w WHERE w.owner_id=i.owner_id AND w.enabled=1 AND w.started_at<=?) AND ${guard} ON CONFLICT DO NOTHING`,
      )
      .bind(
        date,
        now.toISOString(),
        input.source_artifact_id,
        input.segment_map_artifact_id,
        input.selection.source_revision,
        descriptor,
        context.ownerId,
        track.item_id,
        now.toISOString(),
        ...bindings,
      ),
    db
      .prepare(
        `INSERT INTO daily_collections(owner_id,material_date,updated_at) SELECT owner_id,material_date,? FROM daily_materials WHERE owner_id=? AND item_id=? AND material_date=? AND ${guard} ON CONFLICT DO NOTHING`,
      )
      .bind(
        now.toISOString(),
        context.ownerId,
        track.item_id,
        date,
        ...bindings,
      ),
    // Register standalone archive intent in the same fenced acceptance batch.
    // A ready backlog no longer requires rescanning all historical sources per file.
    db
      .prepare(
        `INSERT INTO transcript_archives(owner_id,item_id,source_artifact_id,segment_map_artifact_id,source_hash,descriptor_json,folder_id,due_at,updated_at)
      SELECT i.owner_id,i.item_id,?,COALESCE((SELECT a.artifact_id FROM artifacts a WHERE a.owner_id=i.owner_id AND a.item_id=i.item_id AND a.original_ref=? AND a.kind='SEGMENT_MAP' AND a.schema_version='caption-coverage:1' AND a.state='VERIFIED' LIMIT 1),?),?,json_set(?,'$.video_id',i.external_id,'$.title',COALESCE(json_extract(m.metadata_json,'$.title'),''),'$.channel',COALESCE(c.title,''),'$.url',i.canonical_url,'$.published_at',i.published_at,'$.discovered_at',i.discovered_at),f.folder_id,?,?
      FROM items i JOIN item_revisions m ON m.owner_id=i.owner_id AND m.item_id=i.item_id AND m.revision_id=i.current_revision_id LEFT JOIN channels c ON c.owner_id=i.owner_id AND c.source_id=i.source_id JOIN transcript_archive_folders f ON f.owner_id=i.owner_id AND f.private_verified_at IS NOT NULL
      WHERE i.owner_id=? AND i.item_id=? AND ?='local_ytdlp' AND NOT EXISTS(SELECT 1 FROM daily_materials d WHERE d.owner_id=i.owner_id AND d.item_id=i.item_id) AND ${guard} ON CONFLICT DO NOTHING`,
      )
      .bind(
        input.source_artifact_id,
        input.source_artifact_id,
        input.segment_map_artifact_id,
        input.selection.source_revision,
        descriptor,
        now.toISOString(),
        now.toISOString(),
        context.ownerId,
        track.item_id,
        String(provenance.provider_id),
        ...bindings,
      ),
  ];
}
