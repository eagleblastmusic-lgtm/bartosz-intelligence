import { PromptDrafts } from '../../../../packages/core/src/registry/draft.js';
import { PromptTests } from '../../../../packages/core/src/registry/test.js';
import { PromptPublications } from '../../../../packages/core/src/registry/publish.js';
import { PromptUsage } from '../../../../packages/core/src/registry/usage.js';
import { PromptHistory } from '../../../../packages/core/src/registry/history.js';
import { PromptLab } from '../../../../packages/core/src/registry/lab-store.js';
import {
  LabQuotaPolicies,
  type LabQuotaPolicy,
} from '../../../../packages/core/src/registry/lab-quota.js';
import { ownerRouter, body, queryFields, text } from './common.js';
import type { ApiEnvironment } from './common.js';
import type { Context } from 'hono';
export const promptsApp = ownerRouter();
promptsApp.post('/lab/prepare', async (c) => {
  const input = await body(c, [
    'prompt_id',
    'version',
    'comparison_version',
    'source_run_id',
    'semantic_profile_id',
    'semantic_profile_revision',
    'model_revision',
    'max_output_tokens',
    'purpose',
    'region',
    'limits',
    'repeats',
    'reason',
  ]);
  if (
    !input.limits ||
    typeof input.limits !== 'object' ||
    Array.isArray(input.limits)
  )
    throw new Error('INVALID_PROMPT_TEST');
  return c.json(
    await new PromptLab(c.env.DB, c.get('access')).preparePair(
      input as unknown as Parameters<PromptLab['preparePair']>[0],
      new Date(),
    ),
  );
});
promptsApp.post('/lab/experiments', async (c) => {
  const input = await body(c, ['controls', 'pairs', 'reason']);
  return c.json(
    await new PromptLab(c.env.DB, c.get('access')).create(
      input as unknown as Parameters<PromptLab['create']>[0],
      new Date(),
    ),
  );
});
promptsApp.get('/lab/experiments', async (c) => {
  queryFields(c, ['before']);
  return c.json(
    await new PromptLab(c.env.DB, c.get('access')).list(
      c.req.query('before') ?? null,
    ),
  );
});
promptsApp.get('/lab/experiments/:hash', async (c) => {
  queryFields(c, []);
  return c.json(
    await new PromptLab(c.env.DB, c.get('access')).get(c.req.param('hash')),
  );
});
promptsApp.post('/lab/experiments/:hash/submit', async (c) => {
  const input = await body(c, ['case_index']);
  return c.json(
    await new PromptLab(c.env.DB, c.get('access')).submit(
      c.req.param('hash'),
      input.case_index as number,
      new Date(),
    ),
  );
});
promptsApp.post('/lab/experiments/:hash/cancel', async (c) => {
  const input = await body(c, ['reason']);
  return c.json(
    await new PromptLab(c.env.DB, c.get('access')).cancel(
      c.req.param('hash'),
      text(input.reason, 1000),
      new Date(),
    ),
  );
});
promptsApp.get('/lab/quota', async (c) => {
  queryFields(c, []);
  return c.json(
    await new LabQuotaPolicies(c.env.DB, c.get('access')).current(),
  );
});
promptsApp.post('/lab/quota', async (c) => {
  const input = await body(c, [
    'account_key',
    'model',
    'daily_requests',
    'normal_headroom',
    'expected_revision',
    'reason',
  ]);
  return c.json(
    await new LabQuotaPolicies(c.env.DB, c.get('access')).save(
      {
        version: 'lab-quota:1',
        account_key: text(input.account_key, 200),
        model: text(input.model, 200),
        daily_requests: input.daily_requests as number,
        normal_headroom:
          input.normal_headroom as LabQuotaPolicy['normal_headroom'],
      },
      input.expected_revision as number,
      text(input.reason, 1000),
      new Date(),
    ),
  );
});
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
async function previewRun(
  c: Context<ApiEnvironment>,
  mode: 'QUALITY_TEST' | 'PRODUCTION',
) {
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
      mode,
    ),
  );
}
promptsApp.post('/tests/preview', (c) => previewRun(c, 'QUALITY_TEST'));
promptsApp.post('/apply/preview', (c) => previewRun(c, 'PRODUCTION'));
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
promptsApp.get('/:id/history', async (c) => {
  queryFields(c, ['before']);
  return c.json(
    await new PromptHistory(c.env.DB, c.get('access')).page(
      c.req.param('id'),
      c.req.query('before') === undefined
        ? null
        : Number(c.req.query('before')),
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
