import { env } from 'cloudflare:workers';
import { fixtureOwner, fixtureNow } from './core-fixture.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
import {
  AccessContext,
  type Database,
} from '../../packages/core/src/db/boundary.js';
import { base64url, sha256 } from '../../packages/core/src/auth/crypto.js';
import { captionArchiveCoverage } from '../../packages/core/src/transcript/archive-renderer.js';
import { TranscriptAcceptance } from '../../packages/core/src/transcript/acceptance.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { enqueueYoutubeTranscript } from '../../packages/core/src/transcript/intake.js';
import { DriveClient } from '../../packages/core/src/drive/client.js';
import { selectTranscriptLanguage } from '../../packages/core/src/transcript/language.js';
import type { TrackListResult } from '../../packages/contracts/src/transcript.js';
import { DailyTasksWorkflow } from '../../packages/core/src/daily/workflow.js';
export async function compactFixture(
  count = 1,
  cueCount = 3,
  dailyDrive?: DriveClient,
) {
  const owner = await fixtureOwner(),
    at = fixtureNow.toISOString();
  const source = (await new SourceRepository(env.DB, owner).upsert(
    {
      namespace: 'youtube',
      external_id: 'UC-fixture',
      canonical_locator: 'https://www.youtube.com/channel/UC-fixture',
      title: 'Channel',
      uploads_playlist_id: 'UU-fixture',
      handle: null,
    },
    at,
  ))!;
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind('oracle', 'a', await sha256('oracle'), '["FETCH_TRANSCRIPT"]', at)
    .run();
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind('exporter', 'a', await sha256('exporter'), '["DRIVE_EXPORT"]', at)
    .run();
  const access = await AccessContext.worker(env.DB, await sha256('oracle')),
    exporter = await AccessContext.worker(env.DB, await sha256('exporter'));
  await env.DB.prepare(
    "INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,root_id,root_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','connection','subject-a','client','[]','CONNECTED','daily','VERIFIED',1,'receipt',?,?)",
  )
    .bind(at, at)
    .run();
  await env.DB.prepare(
    "INSERT INTO transcript_archive_folders VALUES('a','connection','parent','transcripts',?)",
  )
    .bind(at)
    .run();
  if (dailyDrive)
    await new DailyTasksWorkflow(env.DB, owner).configure(
      dailyDrive,
      {
        connection_id: 'connection',
        staging_folder_id: 'inbox',
        enabled: true,
      },
      fixtureNow,
    );
  const inputs = [];
  for (let i = 0; i < count; i++) {
    const video = String(i).padStart(11, '0');
    const item = (await new ItemRepository(env.DB, owner).upsert(
      source.source_id,
      {
        namespace: 'youtube',
        external_id: video,
        canonical_url: `https://www.youtube.com/watch?v=${video}`,
        item_type: 'video',
        title: 'Fixture',
        published_at: at,
        publication_provenance: 'SOURCE',
        availability: 'PUBLIC',
        duration_seconds: cueCount,
      },
      at,
    ))!;
    const job = await enqueueYoutubeTranscript(
        env.DB,
        owner,
        video,
        fixtureNow,
      ),
      store = new JobStore(env.DB, access);
    // Benchmark starts with a ready backlog, after the required availability window.
    await env.DB.prepare('UPDATE jobs SET due_at=? WHERE job_id=?')
      .bind(at, job.job_id)
      .run();
    const token = (await store.lease(
      job.job_id,
      'FETCH_TRANSCRIPT',
      fixtureNow,
      'local',
    ))!;
    await store.start(token, 'FETCH_TRANSCRIPT', fixtureNow);
    const cues = Array.from({ length: cueCount }, (_, n) => ({
      upstream_index: n,
      start_ms: n * 1000 + 123,
      end_ms: n * 1000 + 987,
      text: `Exact <b>cue</b> &amp; 😀 ${n % 2}`,
      speaker_label: null,
    }));
    const text = cues.map((c) => c.text).join('\n'),
      hash = await sha256(text),
      raw = JSON.stringify({ events: cues }),
      rawHash = await sha256(raw);
    const provenance = {
      provider_id: 'local_ytdlp',
      provider_version: 'yt-dlp@2026.08.19+yt-dlp-ejs@0.8.0',
      raw_payload_hash: rawHash,
      upstream_track_id: `track-${i}`,
      language_code: 'en',
      track_kind: i % 2 ? 'GENERATED' : 'MANUAL',
      is_generated: Boolean(i % 2),
      is_translated: false,
      is_original: true,
      video_language: 'en',
      original_language: 'en',
      archive_source_status: 'AVAILABLE_FULL',
      missing_ranges: [],
      timestamp_precision: 'CUE',
      warnings: [],
    };
    const identity =
      ':archive-source:1:' + (await sha256(JSON.stringify(provenance)));
    const ids: Record<string, string> = {};
    for (const [kind, body, schema, producer] of [
      ['RAW', raw, 'caption-payload:1', provenance.provider_version],
      [
        'SOURCE_ORIGINAL',
        text,
        'decoded-cue-text:1',
        provenance.provider_version,
      ],
      [
        'SEGMENT_MAP',
        JSON.stringify(captionArchiveCoverage(hash, cues)),
        'caption-coverage:1',
        'caption-coverage:1',
      ],
    ] as const) {
      const bytes = new TextEncoder().encode(body);
      // Seed verified artifacts, then exercise the REAL acceptance/fencing path.
      const id = `${kind}-${i}`;
      ids[kind] = id;
      const chunks = Math.ceil(bytes.length / 32768);
      await env.DB.prepare(
        "INSERT INTO artifacts(artifact_id,owner_id,item_id,kind,content_hash,byte_size,chunk_count,schema_version,producer_version,provenance_json,original_ref,state,created_at,verified_at) VALUES(?,'a',?,?,?,?,?,?,?,?,?,'VERIFIED',?,?)",
      )
        .bind(
          id,
          item.item_id,
          kind,
          await sha256(body),
          bytes.length,
          chunks,
          schema,
          producer + identity,
          JSON.stringify(
            kind === 'SEGMENT_MAP'
              ? { ...provenance, source_revision: hash }
              : provenance,
          ),
          kind === 'SEGMENT_MAP' ? ids.SOURCE_ORIGINAL! : null,
          at,
          at,
        )
        .run();
      for (let index = 0; index < chunks; index++) {
        const part = bytes.slice(index * 32768, (index + 1) * 32768);
        const partHash = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', part)),
          (b) => b.toString(16).padStart(2, '0'),
        ).join('');
        await env.DB.prepare(
          'INSERT INTO artifact_chunks VALUES(?,?,?,?,?,?,?,?,?)',
        )
          .bind(
            'a',
            item.item_id,
            id,
            index,
            index * 32768,
            part.length,
            partHash,
            `d1:${id}/${index}`,
            base64url(part),
          )
          .run();
      }
    }
    const list: TrackListResult = {
      status: 'OK',
      failure_code: null,
      provider_id: 'local_ytdlp',
      provider_version: provenance.provider_version,
      runtime_id: 'local',
      retrieved_at: at,
      request_id: 'fixture',
      tracks: [
        {
          track_id: provenance.upstream_track_id,
          item_id: item.item_id,
          language_code: 'en',
          track_kind: provenance.track_kind as 'MANUAL' | 'GENERATED',
          is_generated: provenance.is_generated,
          is_translated: false,
          is_original: true,
          translation_languages: [],
          source_language: null,
          translation_source_track_id: null,
          is_translatable: null,
          expires_at: '2099-01-01T00:00:00Z',
          extension: 'json3',
        },
      ],
      video_language: 'en',
    };
    const completion = {
      version: 'transcript-source:2' as const,
      raw_artifact_id: ids.RAW!,
      source_artifact_id: ids.SOURCE_ORIGINAL!,
      segment_map_artifact_id: ids.SEGMENT_MAP!,
      selection: selectTranscriptLanguage(list, hash),
      warnings: [],
    };
    await new TranscriptAcceptance(env.DB, access).accept(
      completion,
      token,
      fixtureNow,
    );
    inputs.push({ item, text, raw, cues, completion, token });
  }
  return { owner, exporter, access, inputs };
}
export function memoryDrive() {
  const files = new Map<
    string,
    { meta: Record<string, unknown>; text: string }
  >();
  let generated = 0,
    requests = 0,
    creates = 0,
    fault = '';
  const transport: typeof fetch = async (target, init) => {
    requests++;
    const url = new URL(String(target)),
      id = url.pathname.split('/').at(-1)!;
    if (fault === 'unavailable') return new Response(null, { status: 503 });
    if (url.pathname.endsWith('/permissions'))
      return Response.json({ permissions: [{ type: 'user', role: 'owner' }] });
    if (url.pathname.endsWith('/generateIds'))
      return Response.json({ ids: [`reserved-${++generated}`] });
    if (['transcripts', 'parent'].includes(id))
      return Response.json({
        id,
        name: id,
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['parent'],
        trashed: false,
        version: '1',
      });
    if (init?.method === 'POST') {
      if (fault === 'quota')
        return new Response(null, {
          status: 429,
          headers: { 'Retry-After': '300' },
        });
      const boundary = new Headers(init.headers)
          .get('content-type')!
          .split('boundary=')[1]!,
        parts = String(init.body).split('--' + boundary);
      const meta = JSON.parse(
        parts[1]!.slice(parts[1]!.indexOf('\r\n\r\n') + 4),
      );
      const media = parts[2]!,
        text = media.slice(media.indexOf('\r\n\r\n') + 4, -2);
      if (files.has(meta.id)) return new Response(null, { status: 409 });
      const file = { ...meta, trashed: false, version: '1' };
      files.set(meta.id, { meta: file, text });
      creates++;
      if (fault === 'crash') {
        fault = 'unavailable';
        return new Response(null, { status: 503 });
      }
      return Response.json(file);
    }
    const file = files.get(id);
    if (!file) return new Response(null, { status: 404 });
    if (url.searchParams.get('alt') === 'media')
      return new Response(file.text + (fault === 'hash' ? 'corrupt' : ''));
    return Response.json(file.meta);
  };
  return {
    client: () => new DriveClient('synthetic', transport),
    files,
    get requests() {
      return requests;
    },
    get creates() {
      return creates;
    },
    setFault(value: string) {
      fault = value;
    },
  };
}
export function meterDatabase(db: D1Database) {
  let queries = 0,
    reads = 0,
    writes = 0;
  const underlying = new WeakMap<object, D1PreparedStatement>();
  const record = (result: D1Result) => {
    reads += result.meta.rows_read ?? 0;
    writes += result.meta.rows_written ?? 0;
    return result;
  };
  function wrap(
    s: D1PreparedStatement,
  ): Database['prepare'] extends (...args: never[]) => infer R ? R : never {
    const value = {
      bind: (...v: (string | number | null)[]) => wrap(s.bind(...v)),
      first: async (column?: string) => {
        const row = record(await s.all()).results[0] as
          Record<string, unknown> | undefined;
        return row ? (column ? row[column] : row) : null;
      },
      all: async () => record(await s.all()),
      run: async () => record(await s.run()),
    };
    underlying.set(value, s);
    return value as ReturnType<Database['prepare']>;
  }
  return {
    db: {
      prepare(sql: string) {
        queries++;
        return wrap(db.prepare(sql));
      },
      async batch(statements) {
        return (await db.batch(statements.map((s) => underlying.get(s)!))).map(
          record,
        );
      },
    } as Database,
    reset() {
      queries = reads = writes = 0;
    },
    get stats() {
      return { queries, rows_read: reads, rows_written: writes };
    },
  };
}
