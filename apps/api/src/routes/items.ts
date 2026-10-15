import { ownerRouter, queryFields, text } from './common.js';
import { DailyProjection } from '../../../../packages/core/src/projections/daily.js';
import { artifactRepository } from '../artifact-repository.js';
import { ItemRepository } from '../../../../packages/core/src/db/items.js';
export const itemsApp = ownerRouter();
itemsApp.get('/:id/transcript', async (c) => {
  queryFields(c, ['kind', 'start']);
  const kind = c.req.query('kind') ?? 'source';
  if (!['source', 'segments'].includes(kind))
    throw new Error('INVALID_TRANSCRIPT_KIND');
  const access = c.get('access');
  const itemId = text(c.req.param('id'), 128);
  const accepted = await c.env.DB.prepare(
    "SELECT r.run_id,r.outcome_json FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.item_id=? AND r.state='ACCEPTED' AND j.task_type='FETCH_TRANSCRIPT' AND j.state='SUCCEEDED' AND json_extract(r.outcome_json,'$.version') IN ('transcript-source:1','transcript-source:2') ORDER BY r.accepted_at DESC,r.run_id DESC LIMIT 1",
  )
    .bind(access.ownerId, itemId)
    .first<{ run_id: string; outcome_json: string }>();
  if (!accepted) throw new Error('NOT_FOUND');
  const outcome = JSON.parse(accepted.outcome_json) as {
    source_artifact_id: string;
    segment_map_artifact_id: string;
    source_hash: string;
    authority: Record<string, unknown>;
    warnings: string[];
  };
  const page = await artifactRepository(c.env, access).readOwnerPage(
    kind === 'source'
      ? outcome.source_artifact_id
      : outcome.segment_map_artifact_id,
    Number(c.req.query('start') ?? 0),
  );
  if (
    page.artifact.item_id !== itemId ||
    page.artifact.kind !==
      (kind === 'source' ? 'SOURCE_ORIGINAL' : 'SEGMENT_MAP') ||
    (kind === 'source'
      ? page.artifact.content_hash !== outcome.source_hash
      : page.artifact.original_ref !== outcome.source_artifact_id)
  )
    throw new Error('INVALID_SOURCE_ARTIFACT_SET');
  return c.json({
    run_id: accepted.run_id,
    descriptor: {
      artifact_id: page.artifact.artifact_id,
      content_hash: page.artifact.content_hash,
      byte_size: page.artifact.byte_size,
      chunk_count: page.artifact.chunk_count,
      schema_version: page.artifact.schema_version,
      kind: page.artifact.kind,
      provenance: JSON.parse(page.artifact.provenance_json) as Record<
        string,
        unknown
      >,
      authority: outcome.authority,
      warnings: outcome.warnings,
    },
    chunks: page.chunks.map(
      ({ chunk_index, byte_start, byte_size, byte_hash, body_base64 }) => ({
        chunk_index,
        byte_start,
        byte_size,
        byte_hash,
        body_base64,
      }),
    ),
    next_index: page.next_index,
  });
});
itemsApp.get('/', async (c) => {
  queryFields(c, ['limit', 'cursor']);
  return c.json(
    await new ItemRepository(c.env.DB, c.get('access')).list(
      Number(c.req.query('limit') ?? 20),
      new Date().toISOString(),
      c.env.SESSION_SIGNING_SECRET!,
      c.req.query('cursor'),
    ),
  );
});
itemsApp.get('/:id/detail', async (c) => {
  queryFields(c, []);
  return c.json(
    await new DailyProjection(c.env.DB, c.get('access')).detail(
      text(c.req.param('id'), 128),
    ),
  );
});
itemsApp.get('/:id/canonical', async (c) => {
  queryFields(c, ['run_id', 'start']);
  const context = c.get('access'),
    descriptor = await new DailyProjection(
      c.env.DB,
      context,
    ).canonicalDescriptor(
      text(c.req.param('id'), 128),
      text(c.req.query('run_id'), 128),
    );
  const page = await artifactRepository(c.env, context).readOwnerPage(
    descriptor.artifact_id,
    Number(c.req.query('start') ?? 0),
  );
  return c.json({
    descriptor,
    chunks: page.chunks.map(
      ({ chunk_index, byte_start, byte_size, byte_hash, body_base64 }) => ({
        chunk_index,
        byte_start,
        byte_size,
        byte_hash,
        body_base64,
      }),
    ),
    next_index: page.next_index,
  });
});
