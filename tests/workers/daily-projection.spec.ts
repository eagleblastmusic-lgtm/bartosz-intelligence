import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { DailyProjection } from '../../packages/core/src/projections/daily.js';
import { localDayRange } from '../../packages/core/src/projections/dates.js';
import type {
  AccessContext,
  Database,
} from '../../packages/core/src/db/boundary.js';
import type { JobInput } from '../../packages/contracts/src/jobs.js';
import type { AcceptedView } from '../../packages/contracts/src/daily.js';
const secret = 'fixture-daily-cursor-signing-32-byte-minimum';
const date = '2026-10-05';
const at = fixtureNow.toISOString();
beforeEach(resetCore);
const view: AcceptedView = {
  version: 'accepted-view:1',
  status: 'OK',
  enabled_modules: ['claims'],
  coverage_complete: true,
  summary_pl: [],
  key_points: [],
  entities: [],
  tools: [],
  typed_counts: { claims: 1 },
};
async function source(owner: AccessContext, letter = 'a') {
  return (await new SourceRepository(env.DB, owner).upsert(
    {
      namespace: 'youtube',
      external_id: 'UC' + letter.repeat(22),
      uploads_playlist_id: 'UU' + letter.repeat(22),
      canonical_locator:
        'https://www.youtube.com/channel/UC' + letter.repeat(22),
      title: 'Channel ' + letter,
      handle: '@' + letter,
    },
    at,
  ))!.source_id;
}
function metadata(
  index: number,
  publication: string | null = '2026-10-05T10:00:00.000Z',
) {
  const id = String(index).padStart(11, '0');
  return {
    namespace: 'youtube',
    external_id: id,
    item_type: 'video' as const,
    canonical_url: 'https://www.youtube.com/watch?v=' + id,
    title: 'Video ' + index,
    published_at: publication,
    publication_provenance: publication
      ? 'videos.snippet.publishedAt'
      : 'UNKNOWN',
    availability: 'PUBLIC' as const,
    duration_seconds: 60,
  };
}
function jobInput(
  itemId: string | null,
  sourceId: string,
  type: JobInput['task_type'] = 'ANALYZE',
): JobInput {
  return {
    item_id: itemId,
    source_id: sourceId,
    task_type: type,
    input_revision: 'fixture',
    profile_revision: 'fixture',
    prompt_snapshot_id: null,
    routing_policy_version: 'fixture',
    wire_schema_version: null,
    canonical_schema_version: null,
    enrichment_version: null,
    explicit_run_nonce: crypto.randomUUID(),
    arrival_origin_at: at,
    origin_kind: 'NEW',
    payload: { snapshot: { settings: { mode: 'PRODUCTION' } } },
    priority: 80,
    due_at: at,
  };
}
async function item(
  owner: AccessContext,
  sourceId: string,
  index: number,
  publication?: string | null,
) {
  return (await new ItemRepository(env.DB, owner).upsert(
    sourceId,
    metadata(index, publication),
    at,
  ))!.item_id;
}
async function accept(
  owner: AccessContext,
  sourceId: string,
  itemId: string,
  preview = view,
) {
  const job = (await new JobStore(env.DB, owner).enqueue(
    jobInput(itemId, sourceId),
    at,
  ))!;
  const run = crypto.randomUUID();
  // Projection fixture only. No claim of provider quality or production acceptance.
  await env.DB.prepare(
    "INSERT INTO analysis_runs(run_id,owner_id,item_id,job_id,input_snapshot_json,profile_snapshot_json,routing_snapshot_json,state,outcome_json,created_at,accepted_at) VALUES(?,?,?,?, '{}','{}','{}','ACCEPTED',?,?,?)",
  )
    .bind(
      run,
      owner.ownerId,
      itemId,
      job.job_id,
      JSON.stringify({ version: 'intelligence-accepted:1', view: preview }),
      at,
      at,
    )
    .run();
  await env.DB.prepare(
    'INSERT INTO active_analysis_selections VALUES(?,?,?,?,?)',
  )
    .bind(owner.ownerId, itemId, run, 1, run)
    .run();
  return run;
}
async function scan(
  owner: AccessContext,
  sourceId: string,
  start: string,
  end: string,
  coverage = 'COMPLETE',
  started = '2026-10-04T00:00:00.000Z',
  completed: string | null = '2026-10-06T00:00:00.000Z',
) {
  const job = (await new JobStore(env.DB, owner).enqueue(
      jobInput(null, sourceId, 'DISCOVER'),
      at,
    ))!,
    id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO discovery_scans(scan_id,owner_id,source_id,job_id,window_start,window_end,coverage,started_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      id,
      owner.ownerId,
      sourceId,
      job.job_id,
      start,
      end,
      coverage,
      started,
      completed,
    )
    .run();
  return id;
}
async function day(
  owner: AccessContext,
  limit = 20,
  cursor?: string,
  requestedDate: string | null = date,
  sourceIds?: string[],
) {
  return new DailyProjection(env.DB, owner).day(
    {
      date: requestedDate,
      timezone: 'Europe/Warsaw',
      limit,
      cursor,
      source_ids: sourceIds,
    },
    secret,
    fixtureNow,
  );
}
it('whole-day counts and readiness use selected accepted results, not attempts or enabled summary', async () => {
  const owner = await fixtureOwner(),
    sourceId = await source(owner),
    range = localDayRange(date);
  const ids: string[] = [];
  for (let index = 0; index < 6; index++)
    ids.push(await item(owner, sourceId, index));
  await accept(owner, sourceId, ids[0]!);
  await accept(owner, sourceId, ids[1]!);
  await accept(owner, sourceId, ids[2]!, { ...view, coverage_complete: false });
  await env.DB.prepare(
    "UPDATE items SET availability='PRIVATE' WHERE item_id=?",
  )
    .bind(ids[3]!)
    .run();
  await new JobStore(env.DB, owner).enqueue(jobInput(ids[4]!, sourceId), at);
  // Duplicate and quality diagnostic jobs do not add Items or override readiness.
  await new JobStore(env.DB, owner).enqueue(
    {
      ...jobInput(ids[0]!, sourceId),
      payload: { snapshot: { settings: { mode: 'QUALITY_TEST' } } },
    },
    '2026-10-06T00:00:00.000Z',
  );
  await scan(owner, sourceId, range.start, range.end);
  const first = await day(owner, 1);
  expect(first.counts).toEqual({
    items: 6,
    ready: 2,
    pending: 4,
    blocked: 1,
    failed: 0,
  });
  expect(first.items).toHaveLength(1);
  expect(first.discovery_complete).toBe(true);
  expect(first.complete).toBe(false);
  const all = await day(owner);
  expect(all.items.find((row) => row.item_id === ids[0])).toMatchObject({
    analysis_status: 'READY',
    selected_run_id: expect.any(String),
    view: { enabled_modules: ['claims'], summary_pl: [] },
  });
  expect(all.items.find((row) => row.item_id === ids[2])).toMatchObject({
    analysis_status: 'PARTIAL',
    reason: 'PARTIAL_COVERAGE',
  });
  const next = await day(owner, 1, first.next_cursor!);
  expect(next.items[0]!.item_id).not.toBe(first.items[0]!.item_id);
  expect(next.counts).toEqual(first.counts);
  expect(next.cut_seq).toBe(first.cut_seq);
  await expect(
    day(await fixtureOwner('b'), 1, first.next_cursor!),
  ).rejects.toThrow('INVALID_CURSOR');
  await expect(
    day(owner, 1, first.next_cursor!, date, [sourceId]),
  ).rejects.toThrow('INVALID_CURSOR');
  const old = all.items.find((row) => row.item_id === ids[0])!.selected_run_id;
  const reanalysis = (await new JobStore(env.DB, owner).enqueue(
    jobInput(ids[0]!, sourceId),
    '2026-10-06T04:00:00.000Z',
  ))!;
  const requested = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO analysis_runs(run_id,owner_id,item_id,job_id,input_snapshot_json,profile_snapshot_json,routing_snapshot_json,state,created_at) VALUES(?,?,?,?, '{}','{}','{}','CANDIDATE',?)",
  )
    .bind(requested, owner.ownerId, ids[0]!, reanalysis.job_id, at)
    .run();
  await env.DB.prepare(
    'UPDATE active_analysis_selections SET requested_run_id=?,selection_revision=selection_revision+1 WHERE owner_id=? AND item_id=?',
  )
    .bind(requested, owner.ownerId, ids[0]!)
    .run();
  expect(
    (await day(owner)).items.find((row) => row.item_id === ids[0]),
  ).toMatchObject({
    analysis_status: 'READY',
    selected_run_id: old,
    selection_revision: 2,
    processing_state: 'PENDING',
  });
  await expect(day(owner, 1, first.next_cursor!)).rejects.toThrow(
    'READ_SNAPSHOT_CHANGED',
  );
});
it('incomplete discovery and actual gaps stay incomplete despite a later watermark', async () => {
  const owner = await fixtureOwner(),
    sourceId = await source(owner),
    range = localDayRange(date);
  await env.DB.prepare(
    'UPDATE sources SET window_start=?,last_complete_window_end=? WHERE source_id=?',
  )
    .bind('2026-01-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', sourceId)
    .run();
  await scan(owner, sourceId, range.start, '2026-10-05T06:00:00.000Z');
  await scan(owner, sourceId, '2026-10-05T12:00:00.000Z', range.end);
  expect((await day(owner)).discovery_complete).toBe(false);
  await scan(
    owner,
    sourceId,
    '2026-10-05T06:00:00.000Z',
    '2026-10-05T12:00:00.000Z',
  );
  expect((await day(owner)).complete).toBe(true);
  const pending = await scan(
    owner,
    sourceId,
    range.start,
    range.end,
    'PARTIAL',
    '2026-10-06T01:00:00.000Z',
    null,
  );
  expect((await day(owner)).complete).toBe(false);
  await env.DB.prepare(
    "UPDATE discovery_scans SET coverage='COMPLETE',completed_at='2026-10-06T02:00:00.000Z' WHERE scan_id=?",
  )
    .bind(pending)
    .run();
  expect((await day(owner)).complete).toBe(true);
});
it('metadata corrections invalidate both publication days and changed snapshot cursors fail closed', async () => {
  const owner = await fixtureOwner(),
    sourceId = await source(owner);
  const id = await item(owner, sourceId, 0);
  await item(owner, sourceId, 1);
  const first = await day(owner, 1);
  await new ItemRepository(env.DB, owner).upsert(
    sourceId,
    metadata(0, '2026-10-06T08:00:00.000Z'),
    '2026-10-06T12:00:00.000Z',
  );
  await expect(day(owner, 1, first.next_cursor!)).rejects.toThrow(
    'READ_SNAPSHOT_CHANGED',
  );
  expect((await day(owner)).items.map((row) => row.item_id)).not.toContain(id);
  expect(
    (await day(owner, 20, undefined, '2026-10-06')).items.map(
      (row) => row.item_id,
    ),
  ).toContain(id);
  const changes = (
    await env.DB.prepare(
      "SELECT target_id FROM change_log WHERE owner_id='a' AND event_type='ITEM_METADATA_CHANGED' ORDER BY seq DESC LIMIT 1",
    ).all<{ target_id: string }>()
  ).results;
  expect(JSON.parse(changes[0]!.target_id)).toMatchObject({
    item_id: id,
    old_published_at: '2026-10-05T10:00:00.000Z',
    new_published_at: '2026-10-06T08:00:00.000Z',
  });
});
it('late selection belongs to publication day; undated and foreign source filters remain separate', async () => {
  const owner = await fixtureOwner(),
    foreignOwner = await fixtureOwner('b'),
    sourceId = await source(owner),
    foreignSource = await source(foreignOwner, 'b');
  const id = await item(owner, sourceId, 0, '2026-10-04T21:59:59.000Z');
  const undated = await item(owner, sourceId, 1, null);
  await item(foreignOwner, foreignSource, 2);
  await accept(owner, sourceId, id);
  expect((await day(owner)).counts.items).toBe(0);
  expect(
    (await day(owner, 20, undefined, '2026-10-04')).items[0],
  ).toMatchObject({ item_id: id, analysis_status: 'READY' });
  expect((await day(owner, 20, undefined, null)).items[0]!.item_id).toBe(
    undated,
  );
  await expect(
    day(owner, 20, undefined, date, [foreignSource]),
  ).rejects.toThrow('NOT_FOUND');
  const calendar = await new DailyProjection(env.DB, owner).calendar(
    '2026-10',
    [],
    fixtureNow,
  );
  expect(calendar.days).toHaveLength(31);
  expect(calendar.days.find((d) => d.date === '2026-10-04')!.counts.ready).toBe(
    1,
  );
  expect(calendar.days.find((d) => d.date === date)!.counts.items).toBe(0);
});
it('10k representative cohort uses bounded indexed reads and performs zero mutations', async () => {
  const owner = await fixtureOwner(),
    sourceId = await source(owner);
  await env.DB.batch([
    env.DB.prepare(
      `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO items(item_id,owner_id,source_id,namespace,external_id,item_type,canonical_url,published_at,publication_provenance,discovered_at,availability) SELECT 'large-'||x,'a',?,'youtube',printf('%011d',x),'video','https://www.youtube.com/watch?v='||printf('%011d',x),'2026-10-05T10:00:00.000Z','videos.snippet.publishedAt',?,'PUBLIC' FROM n`,
    ).bind(sourceId, at),
    env.DB.prepare(
      `INSERT INTO item_revisions(revision_id,owner_id,item_id,metadata_hash,metadata_json,fetched_at,availability) SELECT 'rev-'||item_id,owner_id,item_id,'hash-'||item_id,json_object('title',item_id,'duration_seconds',60),?,'PUBLIC' FROM items WHERE owner_id='a'`,
    ).bind(at),
    env.DB.prepare(
      "UPDATE items SET current_revision_id='rev-'||item_id WHERE owner_id='a'",
    ),
    env.DB.prepare(
      `INSERT INTO jobs(job_id,owner_id,item_id,source_id,task_type,input_revision,profile_revision,routing_policy_version,explicit_run_nonce,dedup_key,state,due_at,priority,arrival_origin_at,origin_kind,payload_json,created_at,updated_at)
SELECT 'job-'||item_id,owner_id,item_id,source_id,'ANALYZE','fixture','fixture','fixture','','dedup-'||item_id,CASE CAST(substr(item_id,7) AS INTEGER)%3 WHEN 0 THEN 'SUCCEEDED' WHEN 1 THEN 'DEFERRED' ELSE 'FAILED' END,?,80,?,'NEW','{"snapshot":{"settings":{"mode":"PRODUCTION"}}}',?,? FROM items WHERE owner_id='a'`,
    ).bind(at, at, at, at),
    env.DB.prepare(
      `INSERT INTO analysis_runs(run_id,owner_id,item_id,job_id,input_snapshot_json,profile_snapshot_json,routing_snapshot_json,state,outcome_json,created_at,accepted_at)
SELECT 'run-'||item_id,owner_id,item_id,job_id,'{}','{}','{}','ACCEPTED',?, ?,? FROM jobs WHERE owner_id='a' AND state='SUCCEEDED'`,
    ).bind(
      JSON.stringify({ version: 'intelligence-accepted:1', view }),
      at,
      at,
    ),
    env.DB.prepare(
      "INSERT INTO active_analysis_selections SELECT owner_id,item_id,run_id,1,run_id FROM analysis_runs WHERE owner_id='a'",
    ),
  ]);
  const before = await env.DB.prepare(
    "SELECT COUNT(*) events FROM change_log WHERE owner_id='a'",
  ).first('events');
  const queries: string[] = [];
  let rowsRead: number | null = null;
  const measured: Database = {
    prepare(sql) {
      queries.push(sql);
      return env.DB.prepare(sql);
    },
    async batch(statements) {
      const result = await env.DB.batch(statements as D1PreparedStatement[]);
      rowsRead = result.every((r) => typeof r.meta.rows_read === 'number')
        ? result.reduce((n, r) => n + r.meta.rows_read!, 0)
        : null;
      return result;
    },
  };
  const started = performance.now();
  const result = await new DailyProjection(measured, owner).day(
    { date, timezone: 'Europe/Warsaw', limit: 50 },
    secret,
    fixtureNow,
  );
  const elapsed = performance.now() - started;
  expect(result.counts).toEqual({
    items: 10000,
    ready: 3333,
    pending: 6667,
    blocked: 0,
    failed: 3333,
  });
  expect(result.items).toHaveLength(50);
  expect(queries).toHaveLength(4);
  const plan = (
    await env.DB.prepare('EXPLAIN QUERY PLAN ' + queries[1]!)
      .bind('a', localDayRange(date).start, localDayRange(date).end, '[]', '[]')
      .all<{ detail: string }>()
  ).results
    .map((row) => row.detail)
    .join('\n');
  expect(plan).toContain('items_publication');
  expect(plan).toContain('jobs_item_recent');
  expect(plan).not.toMatch(/SCAN i\b/);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) events FROM change_log WHERE owner_id='a'",
    ).first('events'),
  ).toBe(before);
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM usage_records').first('n'),
  ).toBe(0);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM jobs').first('n')).toBe(
    10000,
  );
  console.log(
    JSON.stringify({
      proof: 'CP-4.1-10k',
      items: result.counts.items,
      page: result.items.length,
      queries: queries.length,
      rows_read: rowsRead,
      local_elapsed_ms: elapsed,
      plan,
      provider_requests: 0,
      mutations: 0,
    }),
  );
});
