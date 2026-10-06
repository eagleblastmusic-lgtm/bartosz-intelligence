import { ownerRouter, body, text, queryFields } from './common.js';
import { SemanticProfiles } from '../../../../packages/core/src/registry/semantic-profiles.js';
import { ModelRegistry } from '../../../../packages/core/src/ai/models.js';
import type { SemanticProfile } from '../../../../packages/core/src/ai/semantic-profile.js';
import {
  AnalysisJobs,
  type AnalysisSettings,
  type ExplicitAnalysisIntent,
} from '../../../../packages/core/src/ai/jobs.js';
export const reprocessApp = ownerRouter();
reprocessApp.get('/context/:item', async (c) => {
  queryFields(c, []);
  const access = c.get('access'),
    itemId = text(c.req.param('item'), 128);
  if (
    !(await c.env.DB.prepare(
      'SELECT 1 FROM items WHERE owner_id=? AND item_id=?',
    )
      .bind(access.ownerId, itemId)
      .first())
  )
    throw new Error('NOT_FOUND');
  const source = await c.env.DB.prepare(
    "SELECT r.run_id FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.item_id=? AND r.state='ACCEPTED' AND j.task_type='FETCH_TRANSCRIPT' AND json_extract(r.outcome_json,'$.authority.authority_confidence')='CONFIRMED' ORDER BY r.accepted_at DESC,r.run_id LIMIT 1",
  )
    .bind(access.ownerId, itemId)
    .first<{ run_id: string }>();
  const selected = await c.env.DB.prepare(
    'SELECT accepted_run_id FROM active_analysis_selections WHERE owner_id=? AND item_id=?',
  )
    .bind(access.ownerId, itemId)
    .first<{ accepted_run_id: string | null }>();
  const model = await new ModelRegistry(c.env.DB, access).latest('gemini_free'),
    profiles = await new SemanticProfiles(c.env.DB, access).list();
  return c.json({
    source_run_id: source?.run_id ?? null,
    candidate_run_id: selected?.accepted_run_id ?? null,
    available: Boolean(
      source &&
      model?.free_eligible &&
      !model.billing_enabled &&
      model.runtimes.includes('local') &&
      Date.parse(model.eligibility_expires_at) > Date.now(),
    ),
    settings: model
      ? {
          runtime: 'local',
          mode: 'PRODUCTION',
          purpose: model.purposes[0] ?? '',
          region: 'PL',
          max_output_tokens: Math.min(4000, model.output_tokens),
          limits: { claims: 40 },
        }
      : null,
    profiles: profiles.profiles.map((p) => {
      const config = JSON.parse(p.config_json as string) as SemanticProfile;
      return {
        profile_id: p.profile_id,
        revision: p.revision,
        name: p.name,
        mode: config.mode,
        second_pass: config.mode === 'CUSTOM' && Boolean(config.second_pass),
        validation_pass:
          config.mode === 'CUSTOM' && Boolean(config.validation_pass),
        optional_tasks: config.translation !== 'NONE' || config.history,
      };
    }),
    has_more: profiles.has_more,
  });
});
reprocessApp.post('/preview', async (c) => {
  const input = await body(c, [
    'source_run_id',
    'settings',
    'semantic_profile_id',
    'semantic_profile_revision',
    'pass',
  ]);
  const settings = input.settings;
  if (
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    Object.keys(settings).some(
      (k) =>
        ![
          'runtime',
          'mode',
          'purpose',
          'region',
          'max_output_tokens',
          'limits',
        ].includes(k),
    )
  )
    throw new Error('INVALID_ANALYSIS_SETTINGS');
  let pass: ExplicitAnalysisIntent['pass'] = null;
  if (input.pass !== null) {
    const value = input.pass;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'candidate_run_id,mode'
    )
      throw new Error('INVALID_ADDITIONAL_PASS');
    const candidate = value as Record<string, unknown>;
    if (candidate.mode !== 'SECOND_PASS' && candidate.mode !== 'VALIDATE')
      throw new Error('INVALID_ADDITIONAL_PASS');
    pass = {
      mode: candidate.mode,
      candidate_run_id: text(candidate.candidate_run_id, 128),
    };
  }
  return c.json(
    await new AnalysisJobs(c.env.DB, c.get('access')).previewExplicit(
      text(input.source_run_id, 128),
      settings as AnalysisSettings,
      {
        semantic_profile_id: text(input.semantic_profile_id, 128),
        semantic_profile_revision: Number(input.semantic_profile_revision),
        pass,
      },
      new Date(),
    ),
  );
});
reprocessApp.post('/confirm', async (c) => {
  const input = await body(c, ['preview_hash', 'nonce']);
  const job = await new AnalysisJobs(c.env.DB, c.get('access')).confirmExplicit(
    text(input.preview_hash, 64),
    text(input.nonce, 128),
    new Date(),
  );
  return c.json(
    {
      job_id: job.job_id,
      state: job.state,
      selection_effect: 'NONE_UNTIL_EXPLICIT_SELECTION',
    },
    201,
  );
});
