import { env } from 'cloudflare:workers';
import { fixtureOwner } from './core-fixture.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
import {
  DriveClient,
  DriveFailure,
  type DriveFile,
} from '../../packages/core/src/drive/client.js';
import { sha256, base64url } from '../../packages/core/src/auth/crypto.js';
import { DailyTasksWorkflow } from '../../packages/core/src/daily/workflow.js';
import { dailyMaterialEffects } from '../../packages/core/src/daily/enrollment.js';
import { captionArchiveCoverage } from '../../packages/core/src/transcript/archive-renderer.js';
import { selectTranscriptLanguage } from '../../packages/core/src/transcript/language.js';
import {
  canonicalTranscriptRoot,
  canonicalReportRoot,
  type DailyManifest,
  type DailyReport,
} from '../../packages/contracts/src/daily-report.js';
import { manifestHash } from '../../packages/core/src/daily/format.js';
import type { Database } from '../../packages/core/src/db/boundary.js';
export class MockDailyDrive extends DriveClient {
  files = new Map<string, DriveFile>();
  texts = new Map<string, string>();
  creates = 0;
  updates = 0;
  nextId = 0;
  fault:
    | ''
    | 'public'
    | 'create-before-write'
    | 'create-after-write'
    | 'corrupt-readback' = '';
  constructor() {
    super('fixture-token', async () => {
      throw new Error('UNEXPECTED_NETWORK_REQUEST');
    });
    for (const id of [canonicalTranscriptRoot, canonicalReportRoot, 'inbox'])
      this.files.set(id, {
        id,
        name: id,
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
        trashed: false,
        version: '1',
        capabilities: { canAddChildren: true },
      });
  }
  override async getFile(id: string) {
    const file = this.files.get(id);
    if (!file) throw new DriveFailure('NOT_FOUND');
    return structuredClone(file);
  }
  override async reserveId() {
    return 'reserved_' + ++this.nextId;
  }
  override async verifyPrivateFolder(id: string) {
    if (this.fault === 'public' || !this.files.has(id))
      throw new DriveFailure('DENIED');
    return { private_owner_only: true as const };
  }
  override async findNamedChildren(parent: string, name: string) {
    return [...this.files.values()]
      .filter(
        (f) =>
          f.name === name && f.parents?.includes(parent) && f.trashed === false,
      )
      .map((f) => structuredClone(f));
  }
  override async createFolder(
    input: Parameters<DriveClient['createFolder']>[0],
  ) {
    this.creates++;
    const file = {
      id: input.reserved_id,
      name: input.name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [input.parent_id!],
      trashed: false,
      version: '1',
      appProperties: input.app_properties,
      capabilities: { canAddChildren: true },
    };
    this.files.set(file.id, file);
    return file;
  }
  override async createMarkdown(
    input: Parameters<DriveClient['createMarkdown']>[0],
  ) {
    this.creates++;
    if (this.fault === 'create-before-write') {
      this.fault = '';
      throw new DriveFailure('TRANSIENT');
    }
    const file = {
      id: input.reserved_id,
      name: input.name,
      mimeType: 'text/markdown',
      parents: [input.root_id],
      trashed: false,
      version: '1',
      appProperties: input.app_properties,
    };
    this.files.set(file.id, file);
    this.texts.set(file.id, input.markdown);
    if (this.fault === 'create-after-write') {
      this.fault = '';
      throw new DriveFailure('TRANSIENT');
    }
    return file;
  }
  override async createTranscriptMarkdown(
    input: Parameters<DriveClient['createTranscriptMarkdown']>[0],
  ) {
    return this.createMarkdown(input);
  }
  override async readMarkdown(id: string) {
    const text = this.texts.get(id);
    if (text === undefined) throw new DriveFailure('NOT_FOUND');
    return this.fault === 'corrupt-readback' ? text.slice(0, 20) : text;
  }
  override async readTranscriptMarkdown(id: string) {
    return this.readMarkdown(id);
  }
  override async readDailyDocument(id: string) {
    return this.readMarkdown(id);
  }
  override async updateMarkdown(
    input?: Parameters<DriveClient['updateMarkdown']>[0],
  ) {
    if (!input) throw new DriveFailure('FORMAT');
    if ((await sha256(this.texts.get(input.id) ?? '')) !== input.expected_hash)
      throw new DriveFailure('CONFLICT');
    await input.before_write?.();
    this.updates++;
    this.texts.set(input.id, input.markdown);
    const f = this.files.get(input.id)!;
    f.version = String(Number(f.version) + 1);
    return {
      method: 'V2_MEDIA_PUT_IF_MATCH' as const,
      content_hash: await sha256(input.markdown),
    };
  }
  addDocument(
    id: string,
    date: string,
    text: string,
    native = true,
    parent = 'inbox',
  ) {
    this.files.set(id, {
      id,
      name: native ? 'BI-Daily-' + date : date + '.md',
      mimeType: native
        ? 'application/vnd.google-apps.document'
        : 'text/markdown',
      parents: [parent],
      trashed: false,
      version: '1',
      capabilities: { canDownload: true },
    });
    this.texts.set(id, text);
  }
}
export async function dailyFixture() {
  const owner = await fixtureOwner(),
    drive = new MockDailyDrive(),
    workflow = new DailyTasksWorkflow(env.DB, owner),
    start = new Date('2026-10-11T10:00:00.000Z');
  await env.DB.prepare(
    "INSERT INTO drive_connections(owner_id,connection_id,account_subject,client_id,scopes_json,auth_state,root_id,root_state,revision,last_intent_hash,created_at,updated_at) VALUES('a','connection','subject-a','client','[]','CONNECTED','old-root','VERIFIED',1,'fixture',?,?)",
  )
    .bind(start.toISOString(), start.toISOString())
    .run();
  await workflow.configure(
    drive,
    { connection_id: 'connection', staging_folder_id: 'inbox', enabled: true },
    start,
  );
  const source = (await new SourceRepository(env.DB, owner).upsert(
    {
      namespace: 'youtube',
      external_id: 'UC-fixture',
      canonical_locator: 'https://www.youtube.com/channel/UC-fixture',
      title: 'Kanał',
      uploads_playlist_id: 'UU-fixture',
      handle: null,
    },
    start.toISOString(),
  ))!;
  async function material(
    videoId = 'rUhllpnYWR8',
    at = '2026-10-11T21:59:59.999Z',
    guard = '1=1',
  ) {
    const item = (await new ItemRepository(env.DB, owner).upsert(
      source.source_id,
      {
        namespace: 'youtube',
        external_id: videoId,
        canonical_url: 'https://www.youtube.com/watch?v=' + videoId,
        item_type: 'video',
        title: 'Film ' + videoId,
        published_at: '2020-01-01T12:00:00.000Z',
        publication_provenance: 'SOURCE',
        availability: 'PUBLIC',
        duration_seconds: 6,
      },
      at,
    ))!;
    const cues = [
      'Pierwsze zdanie 😀',
      'Powtórzenie',
      'Powtórzenie',
      'Ostatnie istotne zastrzeżenie.',
    ].map((text, index) => ({
      upstream_index: index,
      text,
      start_ms: index * 1000,
      end_ms: (index + 1) * 1000,
      speaker_label: null,
    }));
    const text = cues.map((c) => c.text).join('\n'),
      hash = await sha256(text),
      provenance = {
        provider_id: 'local_ytdlp',
        provider_version: 'yt-dlp@2026.08.19+yt-dlp-ejs@0.8.0',
        upstream_track_id: 'track',
        language_code: 'en',
        track_kind: 'MANUAL',
        is_generated: false,
        is_translated: false,
        is_original: true,
        archive_source_status: 'AVAILABLE_FULL',
        missing_ranges: [],
        timestamp_precision: 'CUE',
        warnings: [],
      };
    const sourceId = 'source_' + videoId,
      mapId = 'map_' + videoId;
    if (
      !(await env.DB.prepare('SELECT 1 FROM artifacts WHERE artifact_id=?')
        .bind(sourceId)
        .first())
    )
      for (const [id, kind, body, original] of [
        [sourceId, 'SOURCE_ORIGINAL', text, null],
        [
          mapId,
          'SEGMENT_MAP',
          JSON.stringify(captionArchiveCoverage(hash, cues)),
          sourceId,
        ],
      ] as const) {
        const bytes = new TextEncoder().encode(body),
          sha = await sha256(body);
        await env.DB.prepare(
          "INSERT INTO artifacts(artifact_id,owner_id,item_id,kind,content_hash,byte_size,chunk_count,schema_version,producer_version,provenance_json,original_ref,state,created_at,verified_at) VALUES(?,'a',?,?,?,?,1,'fixture','fixture',?,?,'VERIFIED',?,?)",
        )
          .bind(
            id,
            item.item_id,
            kind,
            sha,
            bytes.length,
            JSON.stringify({ ...provenance, source_revision: hash }),
            original,
            at,
            at,
          )
          .run();
        await env.DB.prepare(
          "INSERT INTO artifact_chunks VALUES('a',?,?,0,0,?,?,?,?)",
        )
          .bind(
            item.item_id,
            id,
            bytes.length,
            sha,
            'd1:' + id + '/0',
            base64url(bytes),
          )
          .run();
      }
    const selection = selectTranscriptLanguage(
      {
        provider_id: 'local_ytdlp',
        provider_version: 'fixture',
        runtime_id: 'local',
        status: 'OK',
        failure_code: null,
        video_language: 'en',
        retrieved_at: at,
        request_id: 'request',
        tracks: [
          {
            track_id: 'track',
            item_id: item.item_id,
            language_code: 'en',
            track_kind: 'MANUAL',
            is_generated: false,
            is_translated: false,
            is_original: true,
            source_language: 'en',
            translation_source_track_id: null,
            is_translatable: false,
            translation_languages: [],
            extension: 'json3',
            expires_at: '2099-01-01T00:00:00Z',
          },
        ],
      },
      hash,
    );
    const db: Database = env.DB;
    await db.batch(
      dailyMaterialEffects(
        env.DB,
        owner,
        {
          raw_artifact_id: 'raw',
          source_artifact_id: sourceId,
          normalized_artifact_id: 'normalized',
          segment_map_artifact_id: mapId,
          offset_map_artifact_id: 'offset',
          selection,
          warnings: [],
        },
        provenance,
        new Date(at),
        guard,
        [],
      ),
    );
    return item;
  }
  return { owner, drive, workflow, material };
}
export async function reportFixture(
  manifest: DailyManifest,
): Promise<DailyReport> {
  return {
    schema: 'bi-daily-report:1',
    material_date: manifest.material_date,
    generated_at: '2026-10-12T06:00:00.000Z',
    timezone: 'Europe/Warsaw',
    manifest_sha256: await manifestHash(manifest),
    expected_count: manifest.expected_count,
    processed_count: manifest.expected_count,
    skipped_count: 0,
    videos: manifest.entries.map((e) => ({
      video_id: e.video_id,
      title: e.title,
      category: 'Nauka',
      youtube_url: e.youtube_url,
      transcript_file_id: e.transcript_file_id,
      material_date: manifest.material_date,
      status: 'PROCESSED',
      reason: null,
      summary:
        'Autor przedstawił konkretne doświadczenie, omówił wyniki, metodę i ograniczenia oraz zastrzegł, że dalsze badania pozostają konieczne. '
          .repeat(4)
          .trim(),
    })),
  };
}
