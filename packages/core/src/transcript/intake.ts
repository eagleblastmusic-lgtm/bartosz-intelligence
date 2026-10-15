import type { AccessContext, Database } from '../db/boundary.js';
import { ItemRepository } from '../db/items.js';
import { JobStore } from '../jobs/store.js';
import { firstCaptionAttempt } from './recovery.js';

export function youtubeVideoId(locator: string): string {
  if (/^[A-Za-z0-9_-]{11}$/.test(locator)) return locator;
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    throw new Error('INVALID_YOUTUBE_VIDEO');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    throw new Error('INVALID_YOUTUBE_VIDEO');
  let id: string | undefined;
  if (url.hostname === 'youtu.be') id = url.pathname.slice(1);
  else if (
    ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)
  ) {
    if (url.pathname === '/watch' && url.searchParams.getAll('v').length === 1)
      id = url.searchParams.get('v') ?? undefined;
    else id = /^\/(?:shorts|live|embed)\/([^/]+)$/.exec(url.pathname)?.[1];
  }
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id))
    throw new Error('INVALID_YOUTUBE_VIDEO');
  return id;
}

// A submitted video is not a channel subscription or a claim of upstream access.
export async function enqueueYoutubeTranscript(
  db: Database,
  context: AccessContext,
  locator: string,
  now: Date,
) {
  context.requireOwner();
  const video = youtubeVideoId(locator),
    at = now.toISOString();
  let item = await db
    .prepare(
      "SELECT item_id,source_id,discovered_at FROM items WHERE owner_id=? AND namespace='youtube' AND external_id=?",
    )
    .bind(context.ownerId, video)
    .first<{ item_id: string; source_id: string; discovered_at: string }>();
  if (!item) {
    await db
      .prepare(
        "INSERT INTO sources(source_id,owner_id,namespace,external_id,canonical_locator,enabled,profile_revision,activated_at,due_at) VALUES(?,?,'youtube-video',?,?,0,'economy-1',?,?) ON CONFLICT(owner_id,namespace,external_id) DO NOTHING",
      )
      .bind(
        crypto.randomUUID(),
        context.ownerId,
        video,
        'https://www.youtube.com/watch?v=' + video,
        at,
        at,
      )
      .run();
    const source = await db
      .prepare(
        "SELECT source_id FROM sources WHERE owner_id=? AND namespace='youtube-video' AND external_id=?",
      )
      .bind(context.ownerId, video)
      .first<{ source_id: string }>();
    const stored = await new ItemRepository(db, context).upsert(
      source!.source_id,
      {
        namespace: 'youtube',
        external_id: video,
        item_type: 'video',
        canonical_url: 'https://www.youtube.com/watch?v=' + video,
        title: video,
        published_at: null,
        publication_provenance: 'USER_SUBMITTED',
        availability: 'UNKNOWN',
        duration_seconds: null,
      },
      at,
    );
    item = {
      item_id: stored!.item_id,
      source_id: source!.source_id,
      discovered_at: at,
    };
  }
  const existing = await db
    .prepare(
      "SELECT job_id,state FROM jobs WHERE owner_id=? AND item_id=? AND task_type='FETCH_TRANSCRIPT' ORDER BY created_at DESC,job_id DESC LIMIT 1",
    )
    .bind(context.ownerId, item.item_id)
    .first<{ job_id: string; state: string }>();
  if (existing) return { video_id: video, item_id: item.item_id, ...existing };
  const job = await new JobStore(db, context).enqueue(
    {
      item_id: item.item_id,
      source_id: item.source_id,
      task_type: 'FETCH_TRANSCRIPT',
      input_revision: 'manual-intake:1',
      profile_revision: 'economy-1',
      routing_policy_version: 'local-primary-1',
      prompt_snapshot_id: null,
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: at,
      origin_kind: 'NEW',
      payload: {},
      priority: 80,
      due_at: firstCaptionAttempt(item.discovered_at),
    },
    at,
  );
  return {
    video_id: video,
    item_id: item.item_id,
    job_id: job!.job_id,
    state: job!.state,
  };
}
