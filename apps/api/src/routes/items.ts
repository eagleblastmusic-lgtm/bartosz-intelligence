import { ownerRouter, queryFields } from './common.js';
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
