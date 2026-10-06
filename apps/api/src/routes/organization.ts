import { ownerRouter, queryFields, body, text } from './common.js';
import { KnowledgeOrganization } from '../../../../packages/core/src/knowledge/organization.js';
export const organizationApp = ownerRouter();
function revision(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error('INVALID_REVISION');
  return Number(value);
}
function active(value: unknown) {
  if (typeof value !== 'boolean') throw new Error('INVALID_ACTIVE');
  return value;
}
organizationApp.get('/spaces', async (c) => {
  queryFields(c, []);
  const result = await new KnowledgeOrganization(
    c.env.DB,
    c.get('access'),
  ).spaces();
  return c.json({
    spaces: result.slice(0, 200),
    has_more: result.length > 200,
  });
});
organizationApp.post('/spaces', async (c) => {
  const input = await body(c, [
    'space_id',
    'name',
    'active',
    'expected_revision',
    'mutation_id',
  ]);
  return c.json(
    await new KnowledgeOrganization(c.env.DB, c.get('access')).space(
      {
        space_id: text(input.space_id, 36),
        name: text(input.name, 120),
        active: active(input.active),
        expected_revision: revision(input.expected_revision),
        mutation_id: text(input.mutation_id, 36),
      },
      new Date(),
    ),
  );
});
organizationApp.get('/items/:id', async (c) => {
  queryFields(c, []);
  return c.json(
    await new KnowledgeOrganization(c.env.DB, c.get('access')).read(
      text(c.req.param('id'), 128),
    ),
  );
});
organizationApp.post('/items/:id/membership', async (c) => {
  const input = await body(c, [
    'space_id',
    'active',
    'expected_revision',
    'mutation_id',
  ]);
  return c.json(
    await new KnowledgeOrganization(c.env.DB, c.get('access')).membership(
      {
        item_id: text(c.req.param('id'), 128),
        space_id: text(input.space_id, 36),
        active: active(input.active),
        expected_revision: revision(input.expected_revision),
        mutation_id: text(input.mutation_id, 36),
      },
      new Date(),
    ),
  );
});
organizationApp.post('/items/:id/review', async (c) => {
  const input = await body(c, [
    'action',
    'reviewed_run_id',
    'expected_revision',
    'mutation_id',
  ]);
  const action = text(input.action, 16);
  if (!['SAVE', 'UNSAVE', 'OPEN', 'READ', 'REVIEW'].includes(action))
    throw new Error('INVALID_REVIEW_STATE');
  return c.json(
    await new KnowledgeOrganization(c.env.DB, c.get('access')).review(
      {
        item_id: text(c.req.param('id'), 128),
        action: action as 'SAVE' | 'UNSAVE' | 'OPEN' | 'READ' | 'REVIEW',
        reviewed_run_id:
          input.reviewed_run_id === null
            ? null
            : text(input.reviewed_run_id, 128),
        expected_revision: revision(input.expected_revision),
        mutation_id: text(input.mutation_id, 36),
      },
      new Date(),
    ),
  );
});
organizationApp.post('/items/:id/insights', async (c) => {
  const input = await body(c, [
    'insight_id',
    'text',
    'active',
    'observation_ids',
    'expected_revision',
    'mutation_id',
  ]);
  return c.json(
    await new KnowledgeOrganization(c.env.DB, c.get('access')).insight(
      {
        item_id: text(c.req.param('id'), 128),
        insight_id: text(input.insight_id, 36),
        text: text(input.text, 20000),
        active: active(input.active),
        observation_ids: input.observation_ids as string[],
        expected_revision: revision(input.expected_revision),
        mutation_id: text(input.mutation_id, 36),
      },
      new Date(),
    ),
  );
});
