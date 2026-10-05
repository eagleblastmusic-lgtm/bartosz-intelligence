import { Hono } from 'hono';
import { consumeSignals } from './queue.js';
import { recoverJobs } from './scheduled.js';

const buildVersion = '0.0.1';

export interface Env {
  DB: D1Database;
  BARTOSZ_QUEUE: Queue;
  ASSETS: Fetcher;
}
const app = new Hono<{ Bindings: Env }>();
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
app.all('*', (c) =>
  c.env.ASSETS
    ? c.env.ASSETS.fetch(c.req.raw)
    : c.json({ error: 'ASSETS_UNAVAILABLE' }, 503),
);
export default {
  fetch: app.fetch,
  queue(batch: MessageBatch<unknown>, environment: Env) {
    return consumeSignals(batch, environment?.DB);
  },
  scheduled(
    controller: ScheduledController,
    environment: Env,
    context: ExecutionContext,
  ) {
    context.waitUntil(
      recoverJobs(
        environment.DB,
        environment.BARTOSZ_QUEUE,
        new Date(controller.scheduledTime),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
