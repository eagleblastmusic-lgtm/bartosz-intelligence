import { ownerRouter, body, text, queryFields } from './common.js';
import {
  CoreBackup,
  backupTables,
} from '../../../../packages/core/src/backup/snapshot.js';
import type { BackupTable } from '../../../../packages/core/src/backup/snapshot.js';
export const backupApp = ownerRouter();
backupApp.post('/', async (c) => {
  await body(c, []);
  return c.json(await new CoreBackup(c.env.DB, c.get('access')).begin(), 201);
});
backupApp.get('/:id/chunk', async (c) => {
  queryFields(c, ['table', 'cursor']);
  const table = c.req.query('table');
  if (!backupTables.some((value) => value === table))
    throw new Error('INVALID_BACKUP_TABLE');
  return c.json(
    await new CoreBackup(c.env.DB, c.get('access')).chunk(
      text(c.req.param('id'), 128),
      table as BackupTable,
      Number(c.req.query('cursor') ?? 0),
    ),
  );
});
backupApp.post('/:id/complete', async (c) => {
  await body(c, []);
  return c.json(
    await new CoreBackup(c.env.DB, c.get('access')).complete(
      text(c.req.param('id'), 128),
    ),
  );
});
backupApp.post('/:id/abort', async (c) => {
  await body(c, []);
  await new CoreBackup(c.env.DB, c.get('access')).abort(
    text(c.req.param('id'), 128),
  );
  return c.json({ state: 'FAILED' });
});
backupApp.get('/:id/manifest', async (c) => {
  queryFields(c, []);
  return c.json(
    await new CoreBackup(c.env.DB, c.get('access')).manifest(
      text(c.req.param('id'), 128),
    ),
  );
});
