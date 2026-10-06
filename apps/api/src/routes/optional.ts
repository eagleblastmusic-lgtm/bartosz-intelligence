import { ownerRouter, body, text, queryFields } from './common.js';
import { OptionalTaskPreparation } from '../../../../packages/core/src/ai/tasks/preparation.js';
import { ModelRegistry } from '../../../../packages/core/src/ai/models.js';
import { OptionalResultProjection } from '../../../../packages/core/src/projections/optional.js';
export const optionalApp = ownerRouter();
optionalApp.get('/result/:run', async (c) => {
  queryFields(c, ['start']);
  return c.json(
    await new OptionalResultProjection(c.env.DB, c.get('access')).page(
      text(c.req.param('run'), 128),
      Number(c.req.query('start') ?? 0),
    ),
  );
});
optionalApp.get('/capabilities', async (c) => {
  queryFields(c, []);
  const access = c.get('access'),
    profile = await new ModelRegistry(c.env.DB, access).latest('gemini_free');
  const prompts = await c.env.DB.prepare(
    "SELECT prompt_id FROM prompt_versions WHERE owner_id=? AND version=2 AND status='PUBLISHED' AND prompt_id IN ('FULL_TRANSLATION_V1','HISTORICAL_COMPARE_V1')",
  )
    .bind(access.ownerId)
    .all<{ prompt_id: string }>();
  const eligible = Boolean(
    profile?.profile_id === 'gemini_free' &&
    profile.free_eligible &&
    !profile.billing_enabled &&
    profile.structured_output &&
    profile.runtimes.includes('local') &&
    Date.parse(profile.eligibility_expires_at) > Date.now(),
  );
  return c.json({
    tasks: ['TRANSLATE', 'HISTORICAL_COMPARE'].map((task) => ({
      task,
      adapter_available: true,
      preview_available:
        eligible &&
        Boolean(profile?.task_types.includes(task)) &&
        prompts.results.some(
          (p) =>
            p.prompt_id ===
            (task === 'TRANSLATE'
              ? 'FULL_TRANSLATION_V1'
              : 'HISTORICAL_COMPARE_V1'),
        ),
    })),
    paid_services_enabled: false,
    quota_status: 'UNKNOWN',
  });
});
optionalApp.post('/preview', async (c) => {
  const input = await body(c, ['item_id', 'task', 'scope']);
  if (input.task !== 'TRANSLATE' && input.task !== 'HISTORICAL_COMPARE')
    throw new Error('INVALID_TASK');
  if (
    input.scope !== null &&
    input.scope !== 'FULL' &&
    input.scope !== 'SELECTED_SEGMENTS'
  )
    throw new Error('INVALID_OPTIONAL_SCOPE');
  return c.json(
    await new OptionalTaskPreparation(c.env.DB, c.get('access')).previewForItem(
      text(input.item_id, 128),
      input.task,
      input.scope,
      new Date(),
    ),
  );
});
optionalApp.post('/confirm', async (c) => {
  const input = await body(c, ['preview_hash', 'nonce']);
  return c.json(
    await new OptionalTaskPreparation(c.env.DB, c.get('access')).confirm(
      text(input.preview_hash, 64),
      text(input.nonce, 36),
      new Date(),
    ),
  );
});
optionalApp.get('/results/:item', async (c) => {
  queryFields(c, []);
  const access = c.get('access');
  access.requireOwner();
  const rows = await c.env.DB.prepare(
    `SELECT x.run_id,x.task_type,x.canonical_artifact_id,x.canonical_hash,x.helper_artifact_id,x.mapping_artifact_id,x.source_artifact_id,x.source_hash,x.coverage_json,x.created_at FROM optional_ai_results x JOIN analysis_runs r ON r.owner_id=x.owner_id AND r.run_id=x.run_id AND r.state='ACCEPTED' WHERE x.owner_id=? AND x.item_id=? ORDER BY x.created_at DESC,x.run_id LIMIT 20`,
  )
    .bind(access.ownerId, text(c.req.param('item'), 128))
    .all();
  return c.json({
    results: rows.results,
    limit: 20,
    semantic_verification: 'NOT_ASSERTED',
  });
});
