import bundle from '../../../../config/registry/master-bundle.json';
import { compileSemanticProfile } from '../../../../packages/core/src/ai/semantic-profile.js';
import { SemanticProfiles } from '../../../../packages/core/src/registry/semantic-profiles.js';
import { ownerRouter, body, queryFields, text } from './common.js';
export const profilesApp = ownerRouter();
profilesApp.get('/assignments', async (c) => {
  queryFields(c, []);
  return c.json(
    await new SemanticProfiles(c.env.DB, c.get('access')).assignments(),
  );
});
profilesApp.post('/assignments', async (c) => {
  const input = await body(c, [
    'profile_id',
    'revision',
    'source_id',
    'effective_from',
    'apply_to_pending',
    'reason',
    'expected_generation',
  ]);
  return c.json(
    await new SemanticProfiles(c.env.DB, c.get('access')).assign(
      {
        profile_id: text(input.profile_id, 80),
        revision: input.revision as number,
        source_id: input.source_id as string | null,
        effective_from: text(input.effective_from, 40),
        apply_to_pending: input.apply_to_pending as boolean,
        reason: text(input.reason, 1000),
      },
      input.expected_generation as number,
      new Date(),
    ),
  );
});
profilesApp.get('/', async (c) => {
  queryFields(c, []);
  return c.json(await new SemanticProfiles(c.env.DB, c.get('access')).list());
});
profilesApp.post('/preview', async (c) => {
  const input = await body(c, ['config']);
  const compiled = await compileSemanticProfile(input.config, bundle);
  return c.json(compiled);
});
profilesApp.post('/versions', async (c) => {
  const input = await body(c, [
    'profile_id',
    'revision',
    'name',
    'config',
    'reason',
  ]);
  return c.json(
    await new SemanticProfiles(c.env.DB, c.get('access')).save(
      {
        profile_id: text(input.profile_id, 80),
        revision: input.revision as number,
        name: text(input.name, 120),
        config: input.config,
        reason: text(input.reason, 1000),
      },
      bundle,
      new Date(),
    ),
  );
});
profilesApp.get('/:id/:revision', async (c) => {
  queryFields(c, []);
  const result = await new SemanticProfiles(c.env.DB, c.get('access')).load(
    c.req.param('id'),
    Number(c.req.param('revision')),
  );
  if (!result) throw new Error('NOT_FOUND');
  return c.json(result);
});
