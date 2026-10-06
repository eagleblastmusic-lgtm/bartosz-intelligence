import { ownerRouter, body, queryFields, text } from './common.js';
import { JobStore } from '../../../../packages/core/src/jobs/store.js';
import { RunRepository } from '../../../../packages/core/src/jobs/acceptance.js';
import {
  AnalysisJobs,
  type AnalysisSettings,
} from '../../../../packages/core/src/ai/jobs.js';
import {
  jobStates,
  taskTypes,
} from '../../../../packages/contracts/src/jobs.js';
import {
  decodeCursor,
  encodeCursor,
  pageLimit,
} from '../../../../packages/core/src/db/cursor.js';
export const jobsApp = ownerRouter();
jobsApp.post('/analysis-selection', async (c) => {
  const input = await body(c, ['run_id', 'item_id']),
    access = c.get('access');
  const runId = text(input.run_id, 128),
    itemId = text(input.item_id, 128);
  const allowed = await c.env.DB.prepare(
    "SELECT 1 FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=? AND r.run_id=? AND r.item_id=? AND j.task_type='ANALYZE' AND json_extract(r.routing_snapshot_json,'$.settings.mode')='PRODUCTION'",
  )
    .bind(access.ownerId, runId, itemId)
    .first();
  if (!allowed) throw new Error('NOT_FOUND');
  const revision = await new RunRepository(c.env.DB, access).requestSelection(
    runId,
    itemId,
  );
  return c.json({ selection_revision: revision });
});
jobsApp.post('/analysis', async (c) => {
  const input = await body(c, ['source_run_id', 'settings']);
  const settings = input.settings;
  if (
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    Object.keys(settings).some(
      (key) =>
        ![
          'runtime',
          'mode',
          'purpose',
          'region',
          'max_output_tokens',
          'limits',
        ].includes(key),
    )
  )
    throw new Error('INVALID_ANALYSIS_SETTINGS');
  const job = await new AnalysisJobs(c.env.DB, c.get('access')).enqueue(
    text(input.source_run_id, 128),
    settings as AnalysisSettings,
    new Date(),
  );
  return c.json({ job_id: job!.job_id, state: job!.state }, 201);
});
const columns =
  'job_id,item_id,source_id,task_type,state,reason_code,due_at,priority,attempt_count,lease_until,fencing_token,arrival_origin_at,origin_kind,created_at,updated_at';
jobsApp.get('/', async (c) => {
  queryFields(c, ['limit', 'cursor', 'state', 'task_type']);
  const limit = pageLimit(Number(c.req.query('limit') ?? 20)),
    state = c.req.query('state') ?? null,
    task = c.req.query('task_type') ?? null;
  if (
    (state !== null && !jobStates.some((value) => value === state)) ||
    (task !== null && !taskTypes.some((value) => value === task))
  )
    throw new Error('INVALID_FILTER');
  const access = c.get('access'),
    kind = `jobs:created:desc:${state ?? '*'}:${task ?? '*'}`,
    cursor = c.req.query('cursor');
  const position = cursor
      ? await decodeCursor(
          cursor,
          access.ownerId,
          kind,
          c.env.SESSION_SIGNING_SECRET!,
        )
      : null,
    snapshot = position?.snapshot ?? new Date().toISOString();
  const rows = (
    await c.env.DB.prepare(
      `SELECT ${columns} FROM jobs WHERE owner_id=? AND created_at<=? AND (? IS NULL OR state=?) AND (? IS NULL OR task_type=?) AND (? IS NULL OR created_at<? OR (created_at=? AND job_id<?)) ORDER BY created_at DESC,job_id DESC LIMIT ?`,
    )
      .bind(
        access.ownerId,
        snapshot,
        state,
        state,
        task,
        task,
        position?.time ?? null,
        position?.time ?? null,
        position?.time ?? null,
        position?.id ?? null,
        limit + 1,
      )
      .all<{ job_id: string; created_at: string }>()
  ).results;
  const page = rows.slice(0, limit),
    last = page.at(-1);
  return c.json({
    jobs: page,
    next_cursor:
      rows.length > limit && last
        ? await encodeCursor(
            {
              owner: access.ownerId,
              kind,
              snapshot,
              time: last.created_at,
              id: last.job_id,
            },
            c.env.SESSION_SIGNING_SECRET!,
          )
        : null,
  });
});
jobsApp.get('/:id', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT ${columns} FROM jobs WHERE owner_id=? AND job_id=?`,
  )
    .bind(c.get('access').ownerId, text(c.req.param('id'), 128))
    .first();
  if (!row) throw new Error('NOT_FOUND');
  return c.json(row);
});
jobsApp.post('/:id/replay', async (c) => {
  await body(c, []);
  await new JobStore(c.env.DB, c.get('access')).replay(
    text(c.req.param('id'), 128),
    new Date().toISOString(),
    c.get('correlation'),
  );
  return c.json({ state: 'PENDING' });
});
