import { env } from 'cloudflare:workers';
import { beforeEach, it, expect } from 'vitest';
import {
  resetCore,
  fixtureOwner,
  fixtureNow,
  fixtureSecret,
} from './core-fixture.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import type { Database } from '../../packages/core/src/db/boundary.js';
import { sha256, base64url } from '../../packages/core/src/auth/crypto.js';
import { ArtifactRepository } from '../../packages/core/src/artifacts/store.js';
import { normalizeTranscript } from '../../packages/core/src/transcript/normalize.js';
import { TranscriptDriveArchive } from '../../packages/core/src/transcript/archive.js';
import { DriveClient } from '../../packages/core/src/drive/client.js';
import { DailyProjection } from '../../packages/core/src/projections/daily.js';
import { renderDaily } from '../../packages/core/src/export/renderer.js';
import { provisionTranscriptFolder } from '../../packages/core/src/transcript/archive-folder.js';
import { captionArchiveCoverage } from '../../packages/core/src/transcript/archive-renderer.js';
beforeEach(resetCore);
async function fixture(partial = false) {
  const owner = await fixtureOwner(),
    at = fixtureNow.toISOString();
  const source = (await new SourceRepository(env.DB, owner).upsert(
    {
      namespace: 'youtube',
      external_id: 'UC-fixture',
      canonical_locator: 'https://www.youtube.com/channel/UC-fixture',
      title: 'Kanał',
      uploads_playlist_id: 'UU-fixture',
      handle: null,
    },
    at,
  ))!;
  const item = (await new ItemRepository(env.DB, owner).upsert(
    source.source_id,
    {
      namespace: 'youtube',
      external_id: 'abcdefghijk',
      canonical_url: 'https://www.youtube.com/watch?v=abcdefghijk',
      item_type: 'video',
      title: 'Film',
      published_at: at,
      publication_provenance: 'SOURCE',
      availability: 'PUBLIC',
      duration_seconds: 60,
    },
    at,
  ))!;
  await env.DB.prepare(
    "INSERT INTO worker_identities VALUES('exporter','a',?,'[\"DRIVE_EXPORT\"]',?,NULL)",
  )
    .bind(await sha256('credential'), at)
    .run();
  const worker = await AccessContext.worker(env.DB, await sha256('credential'));
  await env.DB.prepare(
    `INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,root_id,root_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','connection','subject-a','client','[]','CONNECTED','daily','VERIFIED',1,'receipt',?,?)`,
  )
    .bind(at, at)
    .run();
  await env.DB.prepare(
    "INSERT INTO transcript_archive_folders VALUES('a','connection','parent','transcripts',?)",
  )
    .bind(at)
    .run();
  const text = 'Exact <b>source</b> &amp; 😀\nRepeat\nRepeat';
  const hash = await sha256(text),
    n = await normalizeTranscript(
      hash,
      text.split('\n').map((text, index) => ({
        upstream_index: index,
        text,
        start_ms: index * 1000,
        end_ms: (index + 1) * 1000,
        speaker_label: null,
      })),
      'CUE',
    );
  const provenance = {
    provider_id: 'local_ytdlp',
    upstream_track_id: 'track',
    language_code: 'en',
    track_kind: partial ? 'GENERATED' : 'MANUAL',
    is_generated: partial,
    is_translated: false,
    is_original: true,
    archive_source_status: partial ? 'PARTIAL' : 'AVAILABLE_FULL',
    missing_ranges: partial ? [{ start_ms: 3000, end_ms: null }] : [],
    timestamp_precision: 'CUE',
    warnings: [],
  };
  for (const [id, kind, body, original] of [
    ['source', 'SOURCE_ORIGINAL', text, null],
    ['map', 'SEGMENT_MAP', JSON.stringify(n.manifest), 'source'],
  ] as const) {
    const bytes = new TextEncoder().encode(body),
      contentHash = await sha256(body);
    await env.DB.prepare(
      `INSERT INTO artifacts(artifact_id,owner_id,item_id,kind,content_hash,byte_size,chunk_count,schema_version,producer_version,provenance_json,original_ref,state,created_at,verified_at) VALUES(?,'a',?,?,?,?,1,'fixture','fixture',?,?,'VERIFIED',?,?)`,
    )
      .bind(
        id,
        item.item_id,
        kind,
        contentHash,
        bytes.length,
        JSON.stringify({ ...provenance, source_revision: hash }),
        original,
        at,
        at,
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO artifact_chunks VALUES('a',?,?,0,0,? ,?,?,?)",
    )
      .bind(
        item.item_id,
        id,
        bytes.length,
        contentHash,
        `d1:${id}/0`,
        base64url(bytes),
      )
      .run();
  }
  let markdown: string | null = null,
    creates = 0,
    updates = 0,
    version = 1,
    reads = 0,
    fault = '';
  const transport: typeof fetch = async (target, init) => {
    const url = new URL(String(target));
    if (url.pathname.endsWith('/permissions'))
      return Response.json({
        permissions:
          fault === 'public'
            ? [
                { type: 'user', role: 'owner' },
                { type: 'anyone', role: 'reader' },
              ]
            : [{ type: 'user', role: 'owner' }],
      });
    if (url.pathname.endsWith('/generateIds'))
      return Response.json({ ids: ['reserved'] });
    if (
      url.pathname.endsWith('/transcripts') ||
      url.pathname.endsWith('/parent')
    )
      return Response.json({
        id: url.pathname.endsWith('/parent') ? 'parent' : 'transcripts',
        name: url.pathname.endsWith('/parent')
          ? 'Bartosz Intelligence'
          : 'Transkrypcje',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['parent'],
        trashed: false,
        version: '1',
      });
    const file = {
      id: 'reserved',
      name: 'abcdefghijk.md',
      mimeType: 'text/markdown',
      parents: ['transcripts'],
      trashed: false,
      version: String(version),
      appProperties: {
        bi_owner: await sha256('a'),
        bi_transcript: await sha256(item.item_id),
      },
    };
    if (url.pathname.includes('/v2/')) {
      if (init?.method === 'PUT') {
        expect(new Headers(init.headers).get('If-Match')).toBe(
          '"v' + version + '"',
        );
        markdown = String(init.body);
        version++;
        updates++;
        return Response.json({ id: 'reserved' });
      }
      return Response.json({
        id: 'reserved',
        mimeType: 'text/markdown',
        parents: [{ id: 'transcripts' }],
        labels: { trashed: false },
        properties: Object.entries(file.appProperties).map(([key, value]) => ({
          key,
          value,
          visibility: 'PRIVATE',
        })),
        etag: '"v' + version + '"',
      });
    }
    if (init?.method === 'POST') {
      if (fault === 'quota')
        return new Response(null, {
          status: 429,
          headers: { 'Retry-After': '300' },
        });
      creates++;
      const boundary = new Headers(init.headers)
        .get('Content-Type')!
        .split('boundary=')[1]!;
      const media = String(init.body).split('--' + boundary)[2]!;
      markdown = media.slice(media.indexOf('\r\n\r\n') + 4, -2);
      if (fault === 'crash') {
        fault = 'unavailable';
        return new Response(null, { status: 503 });
      }
      if (fault === 'timeout') return new Response(null, { status: 503 });
      return Response.json(file);
    }
    if (fault === 'unavailable') return new Response(null, { status: 503 });
    if (!markdown) return new Response(null, { status: 404 });
    if (url.searchParams.get('alt') === 'media') {
      reads++;
      if (fault === 'race') version++;
      return new Response(markdown + (fault === 'hash' ? 'corrupt' : ''));
    }
    return Response.json(file);
  };
  const client = new DriveClient('synthetic', transport),
    archive = () => new TranscriptDriveArchive(env.DB, worker);
  return {
    owner,
    worker,
    item,
    source_id: source.source_id,
    text,
    client,
    archive,
    get markdown() {
      return markdown;
    },
    get creates() {
      return creates;
    },
    get updates() {
      return updates;
    },
    async addRevision() {
      const text = 'New full source.',
        hash = await sha256(text),
        normalized = await normalizeTranscript(
          hash,
          [
            {
              upstream_index: 0,
              text,
              start_ms: 0,
              end_ms: 4000,
              speaker_label: null,
            },
          ],
          'CUE',
        );
      const later = new Date(fixtureNow.getTime() + 1000).toISOString();
      for (const [id, kind, body, original] of [
        ['source-2', 'SOURCE_ORIGINAL', text, null],
        [
          'map-2',
          'SEGMENT_MAP',
          JSON.stringify(normalized.manifest),
          'source-2',
        ],
      ] as const) {
        const bytes = new TextEncoder().encode(body),
          contentHash = await sha256(body);
        await env.DB.prepare(
          `INSERT INTO artifacts(artifact_id,owner_id,item_id,kind,content_hash,byte_size,chunk_count,schema_version,producer_version,provenance_json,original_ref,state,created_at,verified_at) VALUES(?,'a',?,?,?,?,1,'fixture','fixture',?,?,'VERIFIED',?,?)`,
        )
          .bind(
            id,
            item.item_id,
            kind,
            contentHash,
            bytes.length,
            JSON.stringify({ ...provenance, source_revision: hash }),
            original,
            later,
            later,
          )
          .run();
        await env.DB.prepare(
          "INSERT INTO artifact_chunks VALUES('a',?,?,0,0,?,?,?,?)",
        )
          .bind(
            item.item_id,
            id,
            bytes.length,
            contentHash,
            `d1:${id}/0`,
            base64url(bytes),
          )
          .run();
      }
    },
    get reads() {
      return reads;
    },
    setFault(value: string) {
      fault = value;
    },
  };
}
it('scopes an explicit archive to its item without touching another pending source', async () => {
  const f = await fixture();
  expect(
    await f
      .archive()
      .tick(
        { client: async () => f.client, item_id: 'other-item' },
        fixtureNow,
      ),
  ).toEqual({ state: 'IDLE' });
  expect(f.creates).toBe(0);
  expect(
    await env.DB.prepare(
      'SELECT COUNT(*) n FROM transcript_archives',
    ).first<number>('n'),
  ).toBe(0);
  await f
    .archive()
    .tick(
      { client: async () => f.client, item_id: f.item.item_id },
      fixtureNow,
    );
  expect(f.creates).toBe(1);
  expect(
    await env.DB.prepare(
      'SELECT state FROM transcript_archives WHERE item_id=?',
    )
      .bind(f.item.item_id)
      .first<string>('state'),
  ).toBe('VERIFIED');
});
it('prefers compact captured cues over later AI maps and archives without AI completion', async () => {
  const f = await fixture(),
    hash = await sha256(f.text);
  const compact = JSON.stringify(
    captionArchiveCoverage(
      hash,
      f.text.split('\n').map((text, index) => ({
        upstream_index: index,
        text,
        start_ms: index * 1000,
        end_ms: (index + 1) * 1000,
        speaker_label: null,
      })),
    ),
  );
  const bytes = new TextEncoder().encode(compact),
    digest = await sha256(compact);
  const earlier = new Date(fixtureNow.getTime() - 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO artifacts(artifact_id,owner_id,item_id,kind,content_hash,byte_size,chunk_count,schema_version,producer_version,provenance_json,original_ref,state,created_at,verified_at) VALUES('compact','a',?,'SEGMENT_MAP',?,?,1,'caption-coverage:1','caption-coverage:1',?,'source','VERIFIED',?,?)`,
  )
    .bind(
      f.item.item_id,
      digest,
      bytes.length,
      JSON.stringify({ source_revision: hash }),
      earlier,
      earlier,
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO artifact_chunks VALUES('a',?,'compact',0,0,?,?,'d1:compact/0',?)`,
  )
    .bind(f.item.item_id, bytes.length, digest, base64url(bytes))
    .run();
  expect(
    await f.archive().tick({ client: async () => f.client }, fixtureNow),
  ).toMatchObject({ state: 'VERIFIED' });
  expect(
    await env.DB.prepare(
      'SELECT segment_map_artifact_id FROM transcript_archives',
    ).first('segment_map_artifact_id'),
  ).toBe('compact');
  expect(f.markdown).toContain('Exact <b>source</b> &amp; 😀');
});
it.each([false, true])(
  'archives original captions despite no AI result, with exact readback and stable dedup: partial %s',
  async (partial) => {
    const f = await fixture(partial);
    await expect(
      new ArtifactRepository(env.DB, f.worker).get('source'),
    ).rejects.toThrow('NOT_FOUND');
    expect(
      await f.archive().tick({ client: async () => f.client }, fixtureNow),
    ).toMatchObject({ state: 'VERIFIED', file_id: 'reserved' });
    // Successful export releases its lease; independent readback still reads
    // exactly the registered verified source, without granting arbitrary reads.
    const repository = new ArtifactRepository(env.DB, f.worker);
    expect(
      (await repository.readTranscriptArchiveText('source', fixtureNow)).text,
    ).toBe(f.text);
    await env.DB.prepare(
      "UPDATE transcript_archives SET state='CONFLICT',lease_until=NULL WHERE item_id=?",
    )
      .bind(f.item.item_id)
      .run();
    await expect(
      repository.readTranscriptArchiveText('source', fixtureNow),
    ).rejects.toThrow('ARTIFACT_CHUNK_MISSING');
    await env.DB.prepare(
      "UPDATE transcript_archives SET state='VERIFIED' WHERE item_id=?",
    )
      .bind(f.item.item_id)
      .run();
    expect(f.markdown).toContain('Exact <b>source</b> &amp; 😀');
    expect(f.markdown!.match(/\nRepeat\n/g)).toHaveLength(2);
    expect(f.markdown).toContain(
      partial ? 'NIEPEŁNA' : 'Pełny dostępny materiał',
    );
    expect(
      await env.DB.prepare('SELECT COUNT(*) n FROM analysis_runs').first('n'),
    ).toBe(0);
    const snapshot = await new DailyProjection(env.DB, f.owner).day(
      { date: '2026-10-05', timezone: 'Europe/Warsaw', limit: 20 },
      fixtureSecret,
      fixtureNow,
    );
    expect(snapshot.items[0]!.delivery).toBeNull();
    expect(snapshot.items[0]!.transcript_archive?.state).toBe('VERIFIED');
    const daily = await renderDaily({
      snapshot,
      selections: [],
      app_origin: 'https://example.test',
      revision: 1,
    });
    expect(daily.markdown).toContain(
      'https://drive.google.com/file/d/reserved/view',
    );
    expect(
      await f.archive().tick({ client: async () => f.client }, fixtureNow),
    ).toMatchObject({ state: 'IDLE' });
    expect(f.creates).toBe(1);
  },
);
it.each(['timeout', 'crash', 'quota'])(
  'reuses the reserved file after %s without duplicate or AI',
  async (fault) => {
    const f = await fixture();
    f.setFault(fault);
    const first = await f
      .archive()
      .tick({ client: async () => f.client }, fixtureNow);
    expect(first.state).toBe(fault === 'timeout' ? 'VERIFIED' : 'RETRY_WAIT');
    const receipt = await env.DB.prepare(
      'SELECT reserved_file_id,due_at FROM transcript_archives',
    ).first<{ reserved_file_id: string; due_at: string }>();
    expect(receipt!.reserved_file_id).toBe('reserved');
    f.setFault('');
    const second = await f
      .archive()
      .tick(
        { client: async () => f.client },
        new Date(Date.parse(receipt!.due_at) + 1000),
      );
    expect(second.state).toBe(fault === 'timeout' ? 'IDLE' : 'VERIFIED');
    expect(f.creates).toBe(1);
  },
);
it.each(['hash', 'race', 'public'])(
  'refuses verification on %s and preserves source bytes',
  async (fault) => {
    const f = await fixture();
    f.setFault(fault);
    const result = await f
      .archive()
      .tick({ client: async () => f.client }, fixtureNow);
    expect(result.state).not.toBe('VERIFIED');
    expect(
      await env.DB.prepare(
        'SELECT verified_source_artifact_id FROM transcript_archives',
      ).first('verified_source_artifact_id'),
    ).toBeNull();
    expect(
      await env.DB.prepare('SELECT COUNT(*) n FROM artifact_chunks').first('n'),
    ).toBe(2);
  },
);
it('finishes an interrupted source before replacing it, then CAS updates the same film file', async () => {
  const f = await fixture();
  f.setFault('crash');
  expect(
    (await f.archive().tick({ client: async () => f.client }, fixtureNow))
      .state,
  ).toBe('RETRY_WAIT');
  await f.addRevision();
  f.setFault('');
  const later = new Date(fixtureNow.getTime() + 600000);
  expect(
    (await f.archive().tick({ client: async () => f.client }, later)).state,
  ).toBe('VERIFIED');
  expect(
    await env.DB.prepare(
      'SELECT source_artifact_id FROM transcript_archives',
    ).first('source_artifact_id'),
  ).toBe('source');
  expect(
    (await f.archive().tick({ client: async () => f.client }, later)).state,
  ).toBe('VERIFIED');
  expect(
    await env.DB.prepare(
      'SELECT source_artifact_id,reserved_file_id,remote_version FROM transcript_archives',
    ).first(),
  ).toMatchObject({
    source_artifact_id: 'source-2',
    reserved_file_id: 'reserved',
    remote_version: '2',
  });
  expect(f.creates).toBe(1);
  expect(f.updates).toBe(1);
  expect(f.markdown).toContain('New full source.');
});
it('extends cleanup to seven days after the later verified transcript without changing summary completion', async () => {
  const f = await fixture();
  const earlier = new Date(fixtureNow.getTime() - 86400000).toISOString();
  await env.DB.prepare(
    `INSERT INTO retention_items(owner_id,item_id,accepted_run_id,canonical_hash,root_id,publication_date,artifact_id,file_id,remote_version,export_revision,file_hash,verified_at,purge_after,updated_at) VALUES('a',?,'run',?,'daily','2026-10-05','summary','summary-file','1',1,?,?,?,?)`,
  )
    .bind(
      f.item.item_id,
      'c'.repeat(64),
      'd'.repeat(64),
      earlier,
      fixtureNow.toISOString(),
      earlier,
    )
    .run();
  expect(
    (await f.archive().tick({ client: async () => f.client }, fixtureNow))
      .state,
  ).toBe('VERIFIED');
  const receipt = await env.DB.prepare(
    'SELECT purge_after,verified_at FROM retention_items',
  ).first<{ purge_after: string; verified_at: string }>();
  const archivedAt = await env.DB.prepare(
    'SELECT verified_at FROM transcript_archives',
  ).first<string>('verified_at');
  expect(receipt!.purge_after).toBe(
    new Date(Date.parse(archivedAt!) + 7 * 86400000).toISOString(),
  );
  expect(receipt!.verified_at).toBe(earlier);
});
it('resumes a limited-access private subfolder after timeout without changing a shared parent or Daily', async () => {
  const f = await fixture();
  await env.DB.prepare('DELETE FROM transcript_archive_folders').run();
  let exists = false,
    creates = 0;
  const file = {
    id: 'new-folder',
    name: 'Transkrypcje',
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['parent'],
    trashed: false,
    inheritedPermissionsDisabled: true,
    appProperties: {
      bi_owner: await sha256('a'),
      bi_archive: 'transcripts_v1',
    },
  };
  const client = new DriveClient('synthetic', async (target, init) => {
    const url = new URL(String(target));
    if (url.pathname.endsWith('/parent/permissions'))
      return Response.json({
        permissions: [
          { type: 'user', role: 'owner' },
          { type: 'anyone', role: 'reader' },
        ],
      });
    if (url.pathname.endsWith('/permissions'))
      return Response.json({
        permissions: [
          { type: 'user', role: 'owner' },
          {
            type: 'anyone',
            role: 'reader',
            view: 'metadata',
            inheritedPermissionsDisabled: true,
          },
        ],
      });
    if (url.pathname.endsWith('/generateIds'))
      return Response.json({ ids: ['new-folder'] });
    if (url.pathname.endsWith('/parent'))
      return Response.json({
        id: 'parent',
        name: 'Bartosz Intelligence',
        mimeType: 'application/vnd.google-apps.folder',
        trashed: false,
      });
    if (init?.method === 'POST') {
      expect(JSON.parse(String(init.body)).inheritedPermissionsDisabled).toBe(
        true,
      );
      exists = true;
      creates++;
      return new Response(null, { status: 503 });
    }
    expect(init?.method ?? 'GET').toBe('GET');
    if (url.pathname.endsWith('/files')) return Response.json({ files: [] });
    return exists ? Response.json(file) : new Response(null, { status: 404 });
  });
  const input = { connection_id: 'connection', parent_id: 'parent' };
  await expect(
    provisionTranscriptFolder(env.DB, f.owner, client, input, fixtureNow),
  ).resolves.toMatchObject({
    folder_id: 'new-folder',
    private_owner_only: true,
  });
  await expect(
    provisionTranscriptFolder(env.DB, f.owner, client, input, fixtureNow),
  ).resolves.toMatchObject({ folder_id: 'new-folder' });
  expect(creates).toBe(1);
  expect(
    await env.DB.prepare('SELECT root_id FROM drive_connections').first(
      'root_id',
    ),
  ).toBe('daily');
});
it('does not claim ownership of an arbitrary same-name folder or change Daily mapping', async () => {
  const f = await fixture();
  await env.DB.prepare('DELETE FROM transcript_archive_folders').run();
  const client = new DriveClient('synthetic', async (target) =>
    String(target).includes('/permissions')
      ? Response.json({ permissions: [{ type: 'user', role: 'owner' }] })
      : String(target).includes('files?')
        ? Response.json({
            files: [
              {
                id: 'unrelated',
                name: 'Transkrypcje',
                mimeType: 'application/vnd.google-apps.folder',
                parents: ['parent'],
                trashed: false,
              },
            ],
          })
        : Response.json({
            id: 'parent',
            name: 'Bartosz Intelligence',
            mimeType: 'application/vnd.google-apps.folder',
            trashed: false,
          }),
  );
  await expect(
    provisionTranscriptFolder(
      env.DB,
      f.owner,
      client,
      { connection_id: 'connection', parent_id: 'parent' },
      fixtureNow,
    ),
  ).rejects.toThrow('TRANSCRIPT_FOLDER_MAPPING_CONFLICT');
  expect(
    await env.DB.prepare('SELECT root_id FROM drive_connections').first(
      'root_id',
    ),
  ).toBe('daily');
});
it.each(['RETRY_WAIT', 'CONFLICT'])(
  'registers another film when an earlier changed source remains in %s',
  async (state) => {
    const f = await fixture();
    await f.archive().reconcile(fixtureNow);
    await f.addRevision();
    await env.DB.prepare('UPDATE transcript_archives SET state=?')
      .bind(state)
      .run();
    const later = new Date(fixtureNow.getTime() + 2000);
    const sibling = (await new ItemRepository(env.DB, f.owner).upsert(
      f.source_id,
      {
        namespace: 'youtube',
        external_id: 'lmnopqrstuv',
        canonical_url: 'https://www.youtube.com/watch?v=lmnopqrstuv',
        item_type: 'video',
        title: 'Another film',
        published_at: later.toISOString(),
        publication_provenance: 'SOURCE',
        availability: 'PUBLIC',
        duration_seconds: 60,
      },
      later.toISOString(),
    ))!;
    for (const id of ['source', 'map']) {
      await env.DB.prepare(
        `INSERT INTO artifacts(artifact_id,owner_id,item_id,kind,content_hash,byte_size,chunk_count,schema_version,producer_version,provenance_json,original_ref,state,created_at,verified_at) SELECT ?,owner_id,?,kind,content_hash,byte_size,chunk_count,schema_version,producer_version,provenance_json,CASE WHEN original_ref IS NULL THEN NULL ELSE 'sibling-source' END,state,?,? FROM artifacts WHERE artifact_id=?`,
      )
        .bind(
          'sibling-' + id,
          sibling.item_id,
          later.toISOString(),
          later.toISOString(),
          id,
        )
        .run();
      await env.DB.prepare(
        `INSERT INTO artifact_chunks SELECT owner_id,?, ?,chunk_index,byte_start,byte_size,byte_hash,?,body_base64 FROM artifact_chunks WHERE artifact_id=?`,
      )
        .bind(sibling.item_id, 'sibling-' + id, 'd1:sibling-' + id + '/0', id)
        .run();
    }
    await f.archive().reconcile(later);
    expect(
      await env.DB.prepare(
        'SELECT source_artifact_id FROM transcript_archives WHERE item_id=?',
      )
        .bind(sibling.item_id)
        .first('source_artifact_id'),
    ).toBe('sibling-source');
    expect(
      await env.DB.prepare(
        'SELECT state FROM transcript_archives WHERE item_id=?',
      )
        .bind(f.item.item_id)
        .first('state'),
    ).toBe(state);
  },
);
it('reads a representative long original without exceeding the Free per-request SQL budget', async () => {
  const f = await fixture();
  await f.archive().reconcile(fixtureNow);
  const text = 'original bytes\n'.repeat(150000),
    bytes = new TextEncoder().encode(text),
    hash = await sha256(text),
    count = Math.ceil(bytes.length / 32768),
    at = fixtureNow.toISOString();
  await env.DB.prepare(
    `INSERT INTO artifacts(artifact_id,owner_id,item_id,kind,content_hash,byte_size,chunk_count,schema_version,producer_version,provenance_json,state,created_at,verified_at) VALUES('long','a',?,'SOURCE_ORIGINAL',?, ?,?,'fixture','fixture','{}','VERIFIED',?,?)`,
  )
    .bind(f.item.item_id, hash, bytes.length, count, at, at)
    .run();
  for (let index = 0; index < count; index++) {
    const part = bytes.slice(
      index * 32768,
      Math.min(bytes.length, (index + 1) * 32768),
    );
    await env.DB.prepare(
      "INSERT INTO artifact_chunks VALUES('a',?,'long',?, ?,?,?,?,?)",
    )
      .bind(
        f.item.item_id,
        index,
        index * 32768,
        part.length,
        await sha256(new TextDecoder().decode(part)),
        `d1:long/${index}`,
        base64url(part),
      )
      .run();
  }
  await env.DB.prepare(
    "UPDATE transcript_archives SET source_artifact_id='long',source_hash=?,lease_until='2099-01-01T00:00:00.000Z'",
  )
    .bind(hash)
    .run();
  let queries = 0;
  const database: Database = env.DB;
  const counted: Database = {
    prepare(sql) {
      queries++;
      return database.prepare(sql);
    },
    batch: (statements) => database.batch(statements),
  };
  const repository = new ArtifactRepository(counted, f.worker);
  expect(
    (await repository.readVerifiedText('long', 32 * 1024 * 1024)).text,
  ).toBe(text);
  const before = queries;
  queries = 0;
  expect(
    (await repository.readTranscriptArchiveText('long', fixtureNow)).text,
  ).toBe(text);
  expect(before).toBe(1 + 2 * count);
  expect(before).toBeGreaterThan(50);
  expect(queries).toBe(1 + Math.ceil(count / 64));
  expect(queries).toBeLessThan(5);
}, 30000);
