import { ownerRouter, body, text, queryFields } from './common.js';
import { OptionalTaskPreparation } from '../../../../packages/core/src/ai/tasks/preparation.js';
import { ModelRegistry } from '../../../../packages/core/src/ai/models.js';
import { OptionalResultProjection } from '../../../../packages/core/src/projections/optional.js';
import { PromptRegistry } from '../../../../packages/core/src/registry/store.js';
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
  const registry = new PromptRegistry(c.env.DB, access);
  const prompts = await Promise.all(
    ['FULL_TRANSLATION_V1', 'HISTORICAL_COMPARE_V1'].map(async (id) => {
      try {
        return await registry.currentFamily(id);
      } catch (error) {
        if (
          error instanceof Error &&
          ['PROMPT_NOT_CONFIGURED', 'PROMPT_DEPRECATED'].includes(error.message)
        )
          return null;
        throw error;
      }
    }),
  );
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
        prompts.some(
          (p) =>
            p?.prompt_id ===
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
optionalApp.post('/recovery/preview', async (c) => {
  const input = await body(c, ['run_id']);
  return c.json(
    await new OptionalTaskPreparation(
      c.env.DB,
      c.get('access'),
    ).previewRecovery(text(input.run_id, 128), new Date()),
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
  const recoveries = await c.env.DB.prepare(
    `SELECT r.run_id,r.created_at,j.reason_code,COALESCE(json_extract(j.payload_json,'$.snapshot.recovery.generation'),0) AS generation,json_extract(r.outcome_json,'$.mapped.coverage.expected') AS expected,json_extract(r.outcome_json,'$.mapped.coverage.translated') AS translated FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.item_id=? AND r.state='CANDIDATE' AND j.task_type='TRANSLATE' AND json_extract(j.payload_json,'$.snapshot.settings.mode')='PRODUCTION' AND ((j.state='SUCCEEDED' AND j.reason_code='OPTIONAL_PARTIAL_COMPLETE' AND COALESCE(json_extract(r.outcome_json,'$.part_complete'),0)=0 AND json_extract(r.outcome_json,'$.version')='optional-candidate:1' AND json_extract(r.outcome_json,'$.mapped.canonical.status')='OK') OR (j.state='FAILED' AND j.reason_code='OPTIONAL_INVALID_COMPLETE' AND json_extract(r.outcome_json,'$.version')='optional-invalid:1')) ORDER BY r.created_at DESC,r.run_id LIMIT 20`,
  )
    .bind(access.ownerId, text(c.req.param('item'), 128))
    .all();
  return c.json({
    results: rows.results,
    recoveries: recoveries.results,
    limit: 20,
    semantic_verification: 'NOT_ASSERTED',
  });
});
