import { ownerRouter, body, text, queryFields } from './common.js';
import { EntityKnowledge } from '../../../../packages/core/src/knowledge/entities.js';
import { EntityTimeline } from '../../../../packages/core/src/knowledge/entity-timeline.js';
import {
  EntityIdentity,
  type IdentityProposal,
} from '../../../../packages/core/src/knowledge/identity.js';
export const entitiesApp = ownerRouter();
entitiesApp.post('/identity-preview', async (c) => {
  const input = await body(c, [
    'action',
    'source_entity_id',
    'target_entity_id',
    'reason',
    'parent_event_id',
  ]);
  const identity = new EntityIdentity(c.env.DB, c.get('access'));
  if (input.action === 'UNDO')
    return c.json(
      await identity.undoPreview(
        text(input.parent_event_id, 36),
        text(input.reason, 2000),
      ),
    );
  if (input.action !== 'MERGE' && input.action !== 'SPLIT')
    throw new Error('INVALID_IDENTITY_CHANGE');
  return c.json(
    await identity.preview({
      action: input.action,
      source_entity_id: text(input.source_entity_id, 128),
      target_entity_id: text(input.target_entity_id, 128),
      reason: text(input.reason, 2000),
    }),
  );
});
entitiesApp.post('/identity-confirm', async (c) => {
  const input = await body(c, [
    'action',
    'source_entity_id',
    'target_entity_id',
    'parent_event_id',
    'reason',
    'expected',
    'mappings',
    'event_id',
    'impact',
  ]);
  if (
    !['MERGE', 'SPLIT', 'UNDO'].includes(String(input.action)) ||
    !Array.isArray(input.expected) ||
    !Array.isArray(input.mappings) ||
    input.expected.length > 128 ||
    input.mappings.length > 128 ||
    !input.expected.length ||
    !input.mappings.length
  )
    throw new Error('INVALID_IDENTITY_CHANGE');
  return c.json(
    await new EntityIdentity(c.env.DB, c.get('access')).confirm(
      {
        ...input,
        source_entity_id: text(input.source_entity_id, 128),
        target_entity_id: text(input.target_entity_id, 128),
        reason: text(input.reason, 2000),
        event_id: text(input.event_id, 36),
        parent_event_id:
          input.parent_event_id === null
            ? null
            : text(input.parent_event_id, 36),
      } as unknown as IdentityProposal,
      new Date(),
    ),
  );
});
entitiesApp.get('/', async (c) => {
  queryFields(c, ['limit', 'cursor']);
  return c.json(
    await new EntityKnowledge(c.env.DB, c.get('access')).list(
      Number(c.req.query('limit') ?? 20),
      c.env.SESSION_SIGNING_SECRET!,
      new Date(),
      c.req.query('cursor'),
    ),
  );
});
entitiesApp.get('/:id', async (c) => {
  queryFields(c, []);
  return c.json(
    await new EntityKnowledge(c.env.DB, c.get('access')).detail(
      text(c.req.param('id'), 128),
    ),
  );
});
entitiesApp.get('/:id/timeline', async (c) => {
  queryFields(c, ['limit', 'cursor']);
  return c.json(
    await new EntityTimeline(c.env.DB, c.get('access')).page(
      text(c.req.param('id'), 128),
      Number(c.req.query('limit') ?? 20),
      c.env.SESSION_SIGNING_SECRET!,
      new Date(),
      c.req.query('cursor'),
    ),
  );
});
entitiesApp.get('/:id/history', async (c) => {
  queryFields(c, ['limit', 'cursor']);
  return c.json(
    await new EntityTimeline(c.env.DB, c.get('access')).events(
      text(c.req.param('id'), 128),
      Number(c.req.query('limit') ?? 20),
      c.env.SESSION_SIGNING_SECRET!,
      c.req.query('cursor'),
    ),
  );
});
entitiesApp.post('/:id/aliases', async (c) => {
  const input = await body(c, [
    'literal',
    'action',
    'reason',
    'language',
    'expected_revision',
    'decision_id',
  ]);
  if (input.action !== 'APPROVE' && input.action !== 'REVOKE')
    throw new Error('INVALID_ALIAS_DECISION');
  if (!Number.isSafeInteger(input.expected_revision))
    throw new Error('INVALID_REVISION');
  return c.json(
    await new EntityKnowledge(c.env.DB, c.get('access')).decide(
      {
        entity_id: text(c.req.param('id'), 128),
        literal: text(input.literal, 1024),
        action: input.action,
        reason: text(input.reason, 2000),
        language: input.language === null ? null : text(input.language, 35),
        expected_revision: Number(input.expected_revision),
        decision_id: text(input.decision_id, 36),
      },
      new Date(),
    ),
  );
});
