import { ownerRouter, queryFields, body, text } from './common.js';
import { DailyTasksWorkflow } from '../../../../packages/core/src/daily/workflow.js';
import { dailyDriveClient } from '../daily-workflow.js';
export const dailyReportsApp = ownerRouter();
dailyReportsApp.get('/settings', async (c) => {
  queryFields(c, []);
  const settings = await new DailyTasksWorkflow(
    c.env.DB,
    c.get('access'),
  ).settings();
  return c.json({
    enabled: settings?.enabled === 1,
    scheduler_enabled: c.env.DAILY_REPORTS_ENABLED === 'true',
    connection_id: settings?.connection_id ?? null,
    staging_folder_id: settings?.staging_folder_id ?? null,
    chatgpt_tasks_status: 'PENDING_OWNER_ACTION',
    remote_executor_status: 'PENDING_OWNER_ACTION',
  });
});
dailyReportsApp.post('/settings', async (c) => {
  const input = await body(c, [
      'connection_id',
      'staging_folder_id',
      'enabled',
    ]),
    now = new Date(),
    connection = text(input.connection_id, 128);
  const client = await dailyDriveClient(
    c.env,
    c.get('access'),
    connection,
    now,
  );
  return c.json(
    await new DailyTasksWorkflow(c.env.DB, c.get('access')).configure(
      client,
      {
        connection_id: connection,
        staging_folder_id:
          input.staging_folder_id === null
            ? null
            : text(input.staging_folder_id, 200),
        enabled: input.enabled as boolean,
      },
      now,
    ),
  );
});
dailyReportsApp.post('/candidates', async (c) => {
  const input = await body(c, ['file_id', 'material_date']);
  return c.json(
    await new DailyTasksWorkflow(c.env.DB, c.get('access')).registerCandidate(
      text(input.file_id, 200),
      text(input.material_date, 10),
      new Date(),
    ),
    202,
  );
});
dailyReportsApp.post('/sync', async (c) => {
  await body(c, []);
  const workflow = new DailyTasksWorkflow(c.env.DB, c.get('access')),
    settings = await workflow.settings(),
    now = new Date();
  if (!settings?.enabled) return c.json({ state: 'DISABLED' });
  return c.json(
    await workflow.tick(
      await dailyDriveClient(
        c.env,
        c.get('access'),
        settings.connection_id,
        now,
      ),
      now,
    ),
  );
});
dailyReportsApp.get('/calendar', async (c) => {
  queryFields(c, ['month', 'timezone']);
  if (c.req.query('timezone') && c.req.query('timezone') !== 'Europe/Warsaw')
    throw new Error('INVALID_TIMEZONE');
  return c.json(
    await new DailyTasksWorkflow(c.env.DB, c.get('access')).calendar(
      c.req.query('month') ?? '',
    ),
  );
});
dailyReportsApp.get('/:date', async (c) => {
  queryFields(c, []);
  return c.json(
    await new DailyTasksWorkflow(c.env.DB, c.get('access')).day(
      c.req.param('date'),
    ),
  );
});
