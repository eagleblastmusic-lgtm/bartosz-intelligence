import { ownerRouter, queryFields, body } from './common.js';
import {
  KnowledgeSearch,
  type SearchFilters,
} from '../../../../packages/core/src/knowledge/search.js';
import { SearchIndex } from '../../../../packages/core/src/knowledge/search-index.js';
export const searchApp = ownerRouter();
searchApp.post('/rebuild', async (c) => {
  await body(c, []);
  return c.json(
    await new SearchIndex(c.env.DB, c.get('access')).rebuild(new Date()),
  );
});
searchApp.get('/', async (c) => {
  queryFields(c, [
    'q',
    'kind',
    'source_id',
    'space_id',
    'entity_id',
    'limit',
    'cursor',
  ]);
  const filters: SearchFilters = {};
  for (const key of ['kind', 'source_id', 'space_id', 'entity_id'] as const) {
    const value = c.req.query(key);
    if (value !== undefined) filters[key] = value;
  }
  return c.json(
    await new KnowledgeSearch(c.env.DB, c.get('access')).page(
      c.req.query('q') ?? '',
      filters,
      Number(c.req.query('limit') ?? 20),
      c.env.SESSION_SIGNING_SECRET!,
      new Date(),
      c.req.query('cursor'),
    ),
  );
});
searchApp.get('/status', async (c) => {
  queryFields(c, []);
  return c.json(await new SearchIndex(c.env.DB, c.get('access')).metadata());
});
