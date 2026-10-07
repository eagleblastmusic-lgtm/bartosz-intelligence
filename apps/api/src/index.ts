import { Hono } from 'hono';
import { consumeSignals } from './queue.js';
import { scheduleControlPlane } from './scheduled.js';
import { authApp } from './auth.js';
import type { Env } from './env.js';
import { sourcesApp } from './routes/sources.js';
import { itemsApp } from './routes/items.js';
import { evidenceApp } from './routes/evidence.js';
import { jobsApp } from './routes/jobs.js';
import { workersApp } from './routes/workers.js';
import { systemApp } from './routes/system.js';
import { backupApp } from './routes/backup.js';
import { dailyApp } from './routes/daily.js';
import { ledgerApp } from './routes/ledger.js';
import { entitiesApp } from './routes/entities.js';
import { correctionsApp } from './routes/corrections.js';
import { organizationApp } from './routes/organization.js';
import { searchApp } from './routes/search.js';
import { profilesApp } from './routes/profiles.js';
import { optionalApp } from './routes/optional.js';
import { reprocessApp } from './routes/reprocess.js';
import { promptsApp } from './routes/prompts.js';
export type { Env } from './env.js';

const buildVersion = '0.0.1';

const app = new Hono<{ Bindings: Env }>();
app.route('/api/v1/auth', authApp);
app.route('/api/v1/sources', sourcesApp);
app.route('/api/v1/items', itemsApp);
app.route('/api/v1/evidence', evidenceApp);
app.route('/api/v1/jobs', jobsApp);
app.route('/api/v1/system', systemApp);
app.route('/api/v1/backup', backupApp);
app.route('/api/v1/daily', dailyApp);
app.route('/api/v1/ledger', ledgerApp);
app.route('/api/v1/entities', entitiesApp);
app.route('/api/v1/corrections', correctionsApp);
app.route('/api/v1/organization', organizationApp);
app.route('/api/v1/search', searchApp);
app.route('/api/v1/profiles', profilesApp);
app.route('/api/v1/optional', optionalApp);
app.route('/api/v1/reprocess', reprocessApp);
app.route('/api/v1/prompts', promptsApp);
app.route('/internal/workers', workersApp);
app.get('/health', (c) => {
  const bindings = {
    DB: Boolean(c.env.DB),
    BARTOSZ_QUEUE: Boolean(c.env.BARTOSZ_QUEUE),
    ASSETS: Boolean(c.env.ASSETS),
  };
  const ready = Object.values(bindings).every(Boolean);
  return c.json(
    {
      build: buildVersion,
      status: ready ? 'LOCAL_READY' : 'NOT_READY',
      bindings,
    },
    ready ? 200 : 503,
  );
});
app.all('/api/*', (c) => c.json({ error: 'NOT_FOUND' }, 404));
app.all('/api', (c) => c.json({ error: 'NOT_FOUND' }, 404));
app.all('/internal/*', (c) => c.json({ error: 'NOT_FOUND' }, 404));
app.all('*', (c) =>
  c.env.ASSETS
    ? c.env.ASSETS.fetch(c.req.raw)
    : c.json({ error: 'ASSETS_UNAVAILABLE' }, 503),
);
export default {
  fetch: app.fetch,
  queue(batch: MessageBatch<unknown>, environment: Env) {
    return consumeSignals(batch, environment?.DB, environment);
  },
  scheduled(
    controller: ScheduledController,
    environment: Env,
    context: ExecutionContext,
  ) {
    context.waitUntil(
      scheduleControlPlane(
        environment.DB,
        environment.BARTOSZ_QUEUE,
        new Date(controller.scheduledTime),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
