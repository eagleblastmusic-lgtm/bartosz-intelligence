import { ownerRouter, queryFields, body, text } from './common.js';
import {
  KnowledgeCorrections,
  type CorrectionKind,
} from '../../../../packages/core/src/knowledge/corrections.js';
export const correctionsApp = ownerRouter();
correctionsApp.post('/source', async (c) => {
  const input = await body(c, [
    'source_artifact_id',
    'patches',
    'reason',
    'correction_id',
  ]);
  const { SourceCorrectionJobs } =
    await import('../../../../packages/core/src/transcript/correction-jobs.js');
  return c.json(
    await new SourceCorrectionJobs(c.env.DB, c.get('access')).enqueueArtifact(
      text(input.source_artifact_id, 128),
      input.patches as import('../../../../packages/core/src/transcript/corrected-source.js').SourceCorrectionPatch[],
      text(input.reason, 2000),
      text(input.correction_id, 36),
      new Date(),
    ),
  );
});
function kind(value: unknown): CorrectionKind {
  if (value !== 'OBSERVATION_TEXT' && value !== 'ENTITY_LABEL')
    throw new Error('INVALID_CORRECTION_TARGET');
  return value;
}
correctionsApp.get('/:kind/:id', async (c) => {
  queryFields(c, []);
  return c.json(
    await new KnowledgeCorrections(c.env.DB, c.get('access')).read(
      kind(c.req.param('kind')),
      text(c.req.param('id'), 128),
    ),
  );
});
correctionsApp.post('/:kind/:id', async (c) => {
  const input = await body(c, [
    'expected_revision',
    'target_hash',
    'old_value',
    'new_value',
    'action',
    'reason',
    'correction_id',
  ]);
  if (
    !Number.isSafeInteger(input.expected_revision) ||
    (input.action !== 'APPLY' && input.action !== 'REVERT')
  )
    throw new Error('INVALID_CORRECTION');
  return c.json(
    await new KnowledgeCorrections(c.env.DB, c.get('access')).apply(
      {
        target_kind: kind(c.req.param('kind')),
        target_id: text(c.req.param('id'), 128),
        expected_revision: Number(input.expected_revision),
        target_hash: text(input.target_hash, 64),
        old_value: text(input.old_value, 20000),
        new_value: text(input.new_value, 20000),
        action: input.action,
        reason: text(input.reason, 2000),
        correction_id: text(input.correction_id, 36),
      },
      new Date(),
    ),
  );
});
