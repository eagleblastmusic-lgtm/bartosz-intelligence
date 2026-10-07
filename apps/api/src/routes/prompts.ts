import { PromptDrafts } from '../../../../packages/core/src/registry/draft.js';
import { PromptTests } from '../../../../packages/core/src/registry/test.js';
import { PromptPublications } from '../../../../packages/core/src/registry/publish.js';
import { ownerRouter, body, queryFields, text } from './common.js';
export const promptsApp = ownerRouter();
promptsApp.post('/publication/preview', async (c) => {
  const input = await body(c, [
    'action',
    'prompt_id',
    'version',
    'report_hash',
    'reason',
  ]);
  if (input.action !== 'PUBLISH' && input.action !== 'ROLLBACK')
    throw new Error('INVALID_PROMPT_PUBLICATION');
  return c.json(
    await new PromptPublications(c.env.DB, c.get('access')).preview(
      {
        action: input.action,
        prompt_id: text(input.prompt_id, 80),
        version: input.version as number,
        report_hash:
          input.report_hash === null ? null : text(input.report_hash, 64),
        reason: text(input.reason, 1000),
      },
      new Date(),
    ),
  );
});
promptsApp.post('/publication/confirm', async (c) => {
  const input = await body(c, ['preview_hash', 'nonce']);
  return c.json(
    await new PromptPublications(c.env.DB, c.get('access')).confirm(
      text(input.preview_hash, 64),
      text(input.nonce, 36),
      new Date(),
    ),
  );
});
promptsApp.post('/tests', async (c) => {
  const input = await body(c, [
    'prompt_id',
    'version',
    'run_id',
    'model_revision',
  ]);
  return c.json(
    await new PromptTests(c.env.DB, c.get('access')).record(
      text(input.prompt_id, 80),
      input.version as number,
      text(input.run_id, 128),
      input.model_revision as number,
      new Date(),
    ),
  );
});
promptsApp.get('/', async (c) => {
  queryFields(c, []);
  return c.json(await new PromptDrafts(c.env.DB, c.get('access')).families());
});
promptsApp.get('/:id/:version/tests', async (c) => {
  queryFields(c, []);
  return c.json(
    await new PromptTests(c.env.DB, c.get('access')).reports(
      c.req.param('id'),
      Number(c.req.param('version')),
    ),
  );
});
promptsApp.get('/:id/:version', async (c) => {
  queryFields(c, []);
  return c.json(
    await new PromptDrafts(c.env.DB, c.get('access')).version(
      c.req.param('id'),
      Number(c.req.param('version')),
    ),
  );
});
promptsApp.post('/drafts', async (c) => {
  const input = await body(c, [
    'prompt_id',
    'base_version',
    'expected_latest_version',
    'text',
    'reason',
  ]);
  return c.json(
    await new PromptDrafts(c.env.DB, c.get('access')).create(
      {
        prompt_id: text(input.prompt_id, 80),
        base_version: input.base_version as number,
        expected_latest_version: input.expected_latest_version as number,
        text: text(input.text, 120000),
        reason: text(input.reason, 1000),
      },
      new Date(),
    ),
  );
});
