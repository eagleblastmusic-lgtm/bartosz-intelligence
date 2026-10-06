import { ownerRouter, queryFields, text } from './common.js';
import { EvidenceProjection } from '../../../../packages/core/src/projections/evidence.js';
export const evidenceApp = ownerRouter();
evidenceApp.get('/:id', async (c) => {
  queryFields(c, ['run_id']);
  return c.json(
    await new EvidenceProjection(c.env.DB, c.get('access')).read(
      text(c.req.param('id'), 128),
      text(c.req.query('run_id'), 128),
    ),
  );
});
