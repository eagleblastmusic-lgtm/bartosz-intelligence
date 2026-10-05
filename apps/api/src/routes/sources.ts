import { ownerRouter, body, text, queryFields } from './common.js';
import { YoutubeClient } from '../../../../packages/core/src/sources/youtube/client.js';
import { resolveSource } from '../../../../packages/core/src/sources/youtube/resolver.js';
import {
  addSource,
  backfillWindow,
} from '../../../../packages/core/src/sources/youtube/backfill.js';
import { previewBackfill } from '../../../../packages/core/src/sources/youtube/preview.js';
import { SourceRepository } from '../../../../packages/core/src/db/sources.js';
import {
  decodeCursor,
  encodeCursor,
  pageLimit,
} from '../../../../packages/core/src/db/cursor.js';
import type { Env } from '../env.js';
export const sourcesApp = ownerRouter();
function client(env: Env) {
  if (!env.YOUTUBE_API_KEY) throw new Error('PROVIDER_CONFIGURATION_REQUIRED');
  return new YoutubeClient(env.YOUTUBE_API_KEY, 8);
}
function range(input: Record<string, unknown>, now: Date) {
  const option = input.range ?? 30;
  if (
    option !== 'only-new' &&
    option !== 'custom' &&
    option !== 7 &&
    option !== 30 &&
    option !== 90
  )
    throw new Error('INVALID_WINDOW');
  return backfillWindow(
    now,
    option,
    input.start === undefined ? undefined : text(input.start, 64),
    input.end === undefined ? undefined : text(input.end, 64),
  );
}
sourcesApp.post('/resolve', async (c) => {
  const input = await body(c, ['locator']);
  return c.json(await resolveSource(client(c.env), text(input.locator)));
});
sourcesApp.post('/backfill-preview', async (c) => {
  const input = await body(c, ['locator', 'range', 'start', 'end']);
  const upstream = client(c.env),
    identity = await resolveSource(upstream, text(input.locator));
  return c.json(
    await previewBackfill(upstream, identity, range(input, new Date()), 3),
  );
});
sourcesApp.post('/', async (c) => {
  const input = await body(c, ['locator', 'window', 'confirmed_channel_id']);
  if (
    !input.window ||
    typeof input.window !== 'object' ||
    Array.isArray(input.window)
  )
    throw new Error('INVALID_WINDOW');
  const requested = input.window as Record<string, unknown>;
  if (
    Object.keys(requested).some(
      (key) => !['window_start', 'window_end'].includes(key),
    )
  )
    throw new Error('INVALID_WINDOW');
  const now = new Date(),
    window = backfillWindow(
      now,
      'custom',
      text(requested.window_start, 64),
      text(requested.window_end, 64),
    );
  const identity = await resolveSource(client(c.env), text(input.locator));
  if (
    identity.requires_confirmation &&
    input.confirmed_channel_id !== identity.external_id
  )
    throw new Error('INVALID_CHANNEL_CONFIRMATION');
  return c.json(
    await addSource(
      c.env.DB,
      c.get('access'),
      identity,
      text(c.req.header('Idempotency-Key'), 128),
      window,
      now,
    ),
    201,
  );
});
sourcesApp.post('/:id/disable', async (c) => {
  await body(c, []);
  await new SourceRepository(c.env.DB, c.get('access')).disable(
    text(c.req.param('id'), 128),
    new Date().toISOString(),
    c.get('correlation'),
  );
  return c.json({ enabled: false });
});
sourcesApp.get('/', async (c) => {
  queryFields(c, ['limit', 'cursor']);
  const limit = pageLimit(Number(c.req.query('limit') ?? 20)),
    access = c.get('access'),
    kind = 'sources:activated:desc';
  const cursor = c.req.query('cursor'),
    position = cursor
      ? await decodeCursor(
          cursor,
          access.ownerId,
          kind,
          c.env.SESSION_SIGNING_SECRET!,
        )
      : null;
  const snapshot = position?.snapshot ?? new Date().toISOString();
  const rows = (
    await c.env.DB.prepare(
      `SELECT s.source_id,s.external_id,s.canonical_locator,s.enabled,s.profile_revision,s.activated_at,s.last_success_at,s.last_complete_window_end,s.last_rss_at,c.title,c.handle_snapshot FROM sources s JOIN channels c USING(owner_id,source_id) WHERE s.owner_id=? AND s.activated_at<=? AND (? IS NULL OR s.activated_at<? OR (s.activated_at=? AND s.source_id<?)) ORDER BY s.activated_at DESC,s.source_id DESC LIMIT ?`,
    )
      .bind(
        access.ownerId,
        snapshot,
        position?.time ?? null,
        position?.time ?? null,
        position?.time ?? null,
        position?.id ?? null,
        limit + 1,
      )
      .all<{ source_id: string; activated_at: string }>()
  ).results;
  const page = rows.slice(0, limit),
    last = page.at(-1);
  return c.json({
    sources: page,
    sampled_at: new Date().toISOString(),
    next_cursor:
      rows.length > limit && last
        ? await encodeCursor(
            {
              owner: access.ownerId,
              kind,
              snapshot,
              time: last.activated_at,
              id: last.source_id,
            },
            c.env.SESSION_SIGNING_SECRET!,
          )
        : null,
  });
});
