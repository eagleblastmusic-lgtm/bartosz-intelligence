import { PromptDrafts } from '../../../../packages/core/src/registry/draft.js';
import { PromptTests } from '../../../../packages/core/src/registry/test.js';
import { PromptPublications } from '../../../../packages/core/src/registry/publish.js';
import { PromptUsage } from '../../../../packages/core/src/registry/usage.js';
import { ownerRouter, body, queryFields, text } from './common.js';
export const promptsApp = ownerRouter();
promptsApp.post('/deprecate', async (c) => {
  const input = await body(c, [
    'prompt_id',
    'version',
    'expected_hash',
    'reason',
  ]);
  return c.json(
    await new PromptUsage(c.env.DB, c.get('access')).deprecate(
      text(input.prompt_id, 80),
      input.version as number,
      text(input.expected_hash, 64),
      text(input.reason, 1000),
      new Date(),
    ),
  );
});
promptsApp.post('/tests/preview', async (c) => {
  const input = await body(c, [
    'prompt_id',
    'version',
    'source_run_id',
    'semantic_profile_id',
    'semantic_profile_revision',
    'model_revision',
    'max_output_tokens',
    'purpose',
    'region',
    'limits',
  ]);
  if (
    !input.limits ||
    typeof input.limits !== 'object' ||
    Array.isArray(input.limits)
  )
    throw new Error('INVALID_PROMPT_TEST');
  return c.json(
    await new PromptTests(c.env.DB, c.get('access')).preview(
      {
        prompt_id: text(input.prompt_id, 80),
        version: input.version as number,
        source_run_id: text(input.source_run_id, 128),
        semantic_profile_id:
          input.semantic_profile_id === null
            ? null
            : text(input.semantic_profile_id, 80),
        semantic_profile_revision: input.semantic_profile_revision as
          number | null,
        model_revision: input.model_revision as number,
        max_output_tokens: input.max_output_tokens as number,
        purpose: text(input.purpose, 200),
        region: text(input.region, 40),
        limits: input.limits as Record<string, number>,
      },
      new Date(),
    ),
  );
});
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
