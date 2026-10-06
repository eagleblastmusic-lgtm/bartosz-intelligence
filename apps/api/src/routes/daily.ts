import { ownerRouter, queryFields } from './common.js';
import { DailyProjection } from '../../../../packages/core/src/projections/daily.js';
export const dailyApp = ownerRouter();
function sources(value: string | undefined) {
  return value === undefined ? [] : value.split(',');
}
dailyApp.get('/', async (c) => {
  queryFields(c, ['date', 'timezone', 'source_ids', 'limit', 'cursor']);
  return c.json(
    await new DailyProjection(c.env.DB, c.get('access')).day(
      {
        date: c.req.query('date') ?? '',
        timezone: c.req.query('timezone') ?? 'Europe/Warsaw',
        source_ids: sources(c.req.query('source_ids')),
        limit: Number(c.req.query('limit') ?? 20),
        cursor: c.req.query('cursor'),
      },
      c.env.SESSION_SIGNING_SECRET!,
      new Date(),
    ),
  );
});
dailyApp.get('/undated', async (c) => {
  queryFields(c, ['source_ids', 'limit', 'cursor']);
  return c.json(
    await new DailyProjection(c.env.DB, c.get('access')).day(
      {
        date: null,
        timezone: 'Europe/Warsaw',
        source_ids: sources(c.req.query('source_ids')),
        limit: Number(c.req.query('limit') ?? 20),
        cursor: c.req.query('cursor'),
      },
      c.env.SESSION_SIGNING_SECRET!,
      new Date(),
    ),
  );
});
dailyApp.get('/calendar', async (c) => {
  queryFields(c, ['month', 'timezone', 'source_ids']);
  if (c.req.query('timezone') && c.req.query('timezone') !== 'Europe/Warsaw')
    throw new Error('INVALID_TIMEZONE');
  return c.json(
    await new DailyProjection(c.env.DB, c.get('access')).calendar(
      c.req.query('month') ?? '',
      sources(c.req.query('source_ids')),
      new Date(),
    ),
  );
});
