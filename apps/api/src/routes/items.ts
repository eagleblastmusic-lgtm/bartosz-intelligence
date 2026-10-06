import { ownerRouter, queryFields, text } from './common.js';
import { DailyProjection } from '../../../../packages/core/src/projections/daily.js';
import { ArtifactRepository } from '../../../../packages/core/src/artifacts/store.js';
import { ItemRepository } from '../../../../packages/core/src/db/items.js';
export const itemsApp = ownerRouter();
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
  const page = await new ArtifactRepository(c.env.DB, context).readOwnerPage(
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
