import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { executeTranscript } from '../../apps/executor/src/transcript-runner.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import type {
  ArtifactDescriptor,
  ArtifactRow,
} from '../../packages/core/src/artifacts/store.js';
import {
  YtdlpTranscriptProvider,
  ytdlpProviderVersion,
} from '../../apps/executor/src/providers/ytdlp.js';
import type { CaptionProcessRunner } from '../../apps/executor/src/providers/ytdlp.js';
import type {
  TranscriptRequestContext,
  SourceItemRef,
} from '../../packages/contracts/src/transcript.js';
const now = new Date('2026-10-06T00:00:00.000Z'),
  item: SourceItemRef = {
    item_id: 'youtube:fixture0001',
    namespace: 'youtube',
    external_id: 'fixture0001',
    duration_ms: 1000,
  };
const context: TranscriptRequestContext = {
  job_id: 'fixture-job',
  item_id: item.item_id,
  runtime_id: 'local',
  deadline: new Date(now.getTime() + 60000).toISOString(),
  max_bytes: 4096,
  quota_reservation_id: null,
  provider_version: ytdlpProviderVersion,
  request_id: 'fixture-request',
};
const track = {
  language_code: 'en',
  track_kind: 'MANUAL',
  is_generated: false,
  is_translated: false,
  source_language: null,
  translation_source_track_id: null,
  is_translatable: null,
  translation_languages: [],
  is_original: null,
  extension: 'json3',
};
const raw = Buffer.from('{"events":[]}'),
  hash = createHash('sha256').update(raw).digest('hex');
const successful = {
  status: 'OK',
  failure_code: null,
  provider_version: '2026.8.19',
  python_version: '3.14.4',
  tracks: [track],
  video_language: 'en',
  selected: track,
  segments: [
    {
      upstream_index: 0,
      start_ms: 250,
      end_ms: 3500,
      text: 'Exact source — unchanged.',
      speaker_label: null,
    },
  ],
  raw_payload_base64: raw.toString('base64'),
  raw_payload_hash: hash,
  upstream_requests: 3,
  bytes_received: raw.length,
};
it('local transcript orchestration retains raw/source/maps separately, preserves overrun and rejects incomplete or stale acceptance', async () => {
  const provider = new YtdlpTranscriptProvider(
    async () => successful,
    () => now,
  );
  const uploads: {
    text: string;
    descriptor: Omit<
      ArtifactDescriptor,
      'content_hash' | 'byte_size' | 'chunk_count'
    >;
  }[] = [];
  const uploader = {
    upload: async (
      text: string,
      descriptor: Omit<
        ArtifactDescriptor,
        'content_hash' | 'byte_size' | 'chunk_count'
      >,
    ): Promise<ArtifactRow> => {
      uploads.push({ text, descriptor });
      return {
        ...descriptor,
        content_hash: await sha256(text),
        byte_size: new TextEncoder().encode(text).length,
        chunk_count: 1,
        owner_id: 'a',
        artifact_id: descriptor.kind,
        state: 'VERIFIED',
        manifest_hash: 'a'.repeat(64),
        provenance_json: JSON.stringify(descriptor.provenance),
        created_at: now.toISOString(),
        verified_at: now.toISOString(),
      };
    },
  };
  const events: string[] = [];
  const lifecycle = {
    admission: async () => ({ available: true, reason: null }),
    heartbeat: async () => {},
    outcome: async (status: string) => {
      events.push(status);
    },
    diagnostic: async (code: string) => {
      events.push(code);
    },
    accept: async (
      value: Parameters<
        import('../../apps/executor/src/transcript-runner.js').TranscriptLifecycle['accept']
      >[0],
    ) => {
      expect(value.selection.source_revision).toBe(
        await sha256(successful.segments[0]!.text),
      );
      expect(value.warnings).toEqual(['SOURCE_DURATION_OVERRUN']);
      expect(value.source_artifact_id).toBe('SOURCE_ORIGINAL');
      events.push('accepted');
    },
  };
  expect(
    await executeTranscript(item, context, provider, uploader, lifecycle),
  ).toEqual({ accepted: true, reason: null });
  expect(uploads.map((row) => row.descriptor.kind)).toEqual([
    'RAW',
    'SOURCE_ORIGINAL',
    'NORMALIZED',
    'SEGMENT_MAP',
    'OFFSET_MAP',
  ]);
  expect(uploads[0]!.text).toBe(raw.toString());
  expect(uploads[1]!.text).toBe(successful.segments[0]!.text);
  const manifest = JSON.parse(uploads[3]!.text);
  expect(manifest.anchors[0]).toMatchObject({ start_ms: 250, end_ms: 3500 });
  expect(uploads[3]!.descriptor.original_ref).toBe('SOURCE_ORIGINAL');
  expect(events).toEqual(['accepted']);
  uploads.length = 0;
  events.length = 0;
  expect(
    await executeTranscript(item, context, provider, uploader, {
      ...lifecycle,
      heartbeat: async () => {
        throw new Error('stale');
      },
    }),
  ).toEqual({ accepted: false, reason: 'STALE_TRANSCRIPT_LEASE' });
  expect(uploads).toHaveLength(0);
  expect(events).toEqual(['STALE_TRANSCRIPT_LEASE']);
  events.length = 0;
  const partial = {
    capabilities: provider.capabilities.bind(provider),
    list_tracks: provider.list_tracks.bind(provider),
    fetch: async () => {
      const list = await provider.list_tracks(item, context),
        fetched = await provider.fetch(item, list.tracks[0]!, context);
      return {
        ...fetched,
        result: { ...fetched.result, status: 'PARTIAL' as const },
      };
    },
  };
  expect(
    await executeTranscript(item, context, partial, uploader, lifecycle),
  ).toEqual({ accepted: false, reason: 'INCOMPLETE_SOURCE' });
  expect(uploads).toHaveLength(0);
  expect(events).toEqual(['INCOMPLETE_SOURCE']);
});
it('selected local adapter preserves source cues/provenance and warns without clipping source duration overrun', async () => {
  const provider = new YtdlpTranscriptProvider(
      async () => successful,
      () => now,
    ),
    list = await provider.list_tracks(item, context);
  expect(list.status).toBe('OK');
  expect(JSON.stringify(list)).not.toContain('https://');
  expect(list.tracks[0]?.is_original).toBeNull();
  const fetched = await provider.fetch(item, list.tracks[0]!, context);
  expect(fetched.result).toMatchObject({
    status: 'OK',
    provider_version: ytdlpProviderVersion,
    track_kind: 'MANUAL',
    timestamp_precision: 'CUE',
    raw_payload_hash: hash,
    warnings: ['SOURCE_DURATION_OVERRUN'],
    duration_covered_ms: 3500,
  });
  expect(fetched.result.segments[0]).toMatchObject({
    start_ms: 250,
    end_ms: 3500,
    text: 'Exact source — unchanged.',
  });
  expect(Buffer.from(fetched.raw_payload!)).toEqual(raw);
});
it('local runtime/deadline/version/size gates fail before network and preserve all upstream failure categories', async () => {
  let calls = 0;
  const provider = new YtdlpTranscriptProvider(
    async () => {
      calls++;
      return successful;
    },
    () => now,
  );
  expect(
    (await provider.list_tracks(item, { ...context, runtime_id: 'cloud' }))
      .status,
  ).toBe('UNAVAILABLE');
  expect(
    (
      await provider.list_tracks(item, {
        ...context,
        deadline: now.toISOString(),
      })
    ).failure_code,
  ).toBe('DEADLINE_EXCEEDED');
  expect(
    (await provider.list_tracks(item, { ...context, item_id: 'foreign' }))
      .failure_code,
  ).toBe('INVALID_LOCAL_INPUT');
  expect(calls).toBe(0);
  for (const status of [
    'NO_CAPTIONS',
    'IP_BLOCKED',
    'RATE_LIMITED',
    'AUTH_REQUIRED',
    'REGION_BLOCKED',
    'UNAVAILABLE',
    'PARSE_ERROR',
    'UPSTREAM_CHANGED',
    'TOO_LARGE',
    'TEMPORARY_FAILURE',
  ] as const) {
    const failing = new YtdlpTranscriptProvider(
      async () => ({ status, failure_code: 'FIXTURE_REASON', tracks: [] }),
      () => now,
    );
    expect((await failing.list_tracks(item, context)).status).toBe(status);
  }
  const changed = new YtdlpTranscriptProvider(
    async () => ({ ...successful, provider_version: 'unqualified-version' }),
    () => now,
  );
  expect((await changed.list_tracks(item, context)).failure_code).toBe(
    'DEPENDENCY_VERSION_MISMATCH',
  );
});
it('malformed timestamps/hash, oversized source, foreign/expired track and transport error cannot bypass normalized contract', async () => {
  const provider = new YtdlpTranscriptProvider(
      async () => successful,
      () => now,
    ),
    selected = (await provider.list_tracks(item, context)).tracks[0]!;
  for (const response of [
    { ...successful, raw_payload_hash: '0'.repeat(64) },
    { ...successful, segments: [{ ...successful.segments[0], start_ms: -1 }] },
  ]) {
    const malformed = new YtdlpTranscriptProvider(
      async () => response,
      () => now,
    );
    expect((await malformed.fetch(item, selected, context)).result.status).toBe(
      'PARSE_ERROR',
    );
  }
  expect(
    (await provider.fetch(item, selected, { ...context, max_bytes: 1 })).result
      .status,
  ).toBe('TOO_LARGE');
  expect(
    (await provider.fetch(item, { ...selected, item_id: 'foreign' }, context))
      .result.failure_code,
  ).toBe('TRACK_REFERENCE_INVALID');
  expect(
    (
      await provider.fetch(
        item,
        { ...selected, expires_at: now.toISOString() },
        context,
      )
    ).result.failure_code,
  ).toBe('TRACK_REFERENCE_INVALID');
  const transport = new YtdlpTranscriptProvider(
    async () => {
      throw new Error('sensitive upstream transport diagnostic');
    },
    () => now,
  );
  const denied = await transport.fetch(item, selected, context);
  expect(denied.result.failure_code).toBe('LOCAL_HARNESS_FAILURE');
  expect(JSON.stringify(denied)).not.toContain('sensitive');
});
it('one local process at a time and an elapsed deadline prevents a late source success', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const run: CaptionProcessRunner = () => pending;
  let at = now;
  const provider = new YtdlpTranscriptProvider(run, () => at),
    first = provider.list_tracks(item, context);
  expect((await provider.list_tracks(item, context)).failure_code).toBe(
    'LOCAL_EXECUTOR_BUSY',
  );
  at = new Date(now.getTime() + 60001);
  release(successful);
  expect((await first).failure_code).toBe('DEADLINE_EXCEEDED');
});
