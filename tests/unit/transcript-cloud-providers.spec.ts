import { it, expect, vi } from 'vitest';
import { executeTranscript } from '../../apps/executor/src/transcript-runner.js';
import {
  YouTubeWebCaptionProvider,
  parseWebCaptionJson3,
  playerFromWatchPage,
  webCaptionProviderVersion,
} from '../../packages/core/src/transcript/providers/youtube-web.js';
import {
  YouTubeCaptionProvider,
  parseCaptionSrt,
  youtubeCaptionProviderVersion,
} from '../../packages/core/src/transcript/providers/youtube-captions.js';
import {
  freeTranscriptAdmission,
  type FreeTranscriptObservation,
} from '../../packages/core/src/transcript/free-budget.js';
import {
  DriveClient,
  DriveBudgetWait,
} from '../../packages/core/src/drive/client.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
const item = {
  item_id: 'item',
  external_id: 'rUhllpnYWR8',
  namespace: 'youtube' as const,
  duration_ms: null,
};
const context = (version = webCaptionProviderVersion) => ({
  job_id: 'job',
  item_id: 'item',
  runtime_id: 'cloud' as const,
  deadline: new Date(Date.now() + 60000).toISOString(),
  max_bytes: 1048576,
  quota_reservation_id: null,
  provider_version: version,
  request_id: 'request',
});
function page(tracks = true, exp = '') {
  return (
    'var ytInitialPlayerResponse = ' +
    JSON.stringify({
      playabilityStatus: { status: 'OK' },
      videoDetails: {
        videoId: item.external_id,
        title: 'Test { } title',
        defaultAudioLanguage: 'en',
      },
      captions: tracks
        ? {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                {
                  baseUrl:
                    'https://www.youtube.com/api/timedtext?v=' +
                    item.external_id +
                    exp,
                  languageCode: 'en',
                  kind: 'asr',
                },
              ],
            },
          }
        : undefined,
    }) +
    ';'
  );
}
it('fetches every JSON3 source event, preserves Unicode/repeats/final cue and checks the raw checksum', async () => {
  const caption = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: ' 😀 first ' }] },
      { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'Repeat' }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'Repeat' }] },
      { tStartMs: 3000, dDurationMs: 500, segs: [{ utf8: 'Last caveat.' }] },
    ],
  });
  const seen: string[] = [];
  const provider = new YouTubeWebCaptionProvider(async (input, init) => {
    const u = new URL(String(input));
    seen.push(u.pathname);
    expect(new Headers(init?.headers).has('Cookie')).toBe(false);
    expect(init?.redirect).toBe('manual');
    return new Response(u.pathname === '/watch' ? page() : caption);
  });
  const list = await provider.list_tracks(item, context()),
    result = await provider.fetch(item, list.tracks[0]!, context());
  expect(list.status).toBe('OK');
  expect(list.tracks[0]!.track_kind).toBe('GENERATED');
  expect(result.result.status).toBe('OK');
  expect(result.result.raw_payload_hash).toBe(await sha256(caption));
  expect(result.result.segments.map((s) => s.text)).toEqual([
    ' 😀 first ',
    'Repeat',
    'Repeat',
    'Last caveat.',
  ]);
  expect(seen).toEqual(['/watch', '/api/timedtext']);
  expect(provider.capabilities('cloud').free_eligibility).toBe(false);
});
it.each([403, 429, 503])(
  'classifies HTTP %s without fallback, cookies or retries',
  async (status) => {
    let requests = 0;
    const provider = new YouTubeWebCaptionProvider(async () => {
      requests++;
      return new Response(null, { status });
    });
    expect((await provider.list_tracks(item, context())).status).toBe(
      status === 403
        ? 'IP_BLOCKED'
        : status === 429
          ? 'RATE_LIMITED'
          : 'TEMPORARY_FAILURE',
    );
    expect(requests).toBe(1);
  },
);
it('does not label an empty body, malformed tail, missing timing or bot response complete', async () => {
  expect(() => parseWebCaptionJson3('')).toThrow('EMPTY_CAPTION_RESPONSE');
  expect(() => parseWebCaptionJson3('{"events":[')).toThrow();
  expect(() =>
    parseWebCaptionJson3(
      JSON.stringify({
        events: [
          { tStartMs: 0, dDurationMs: 1, segs: [{ utf8: 'ok' }] },
          { tStartMs: 1, segs: [{ utf8: 'tail' }] },
        ],
      }),
    ),
  ).toThrow('INCOMPLETE_CAPTION_TIMING');
  const provider = new YouTubeWebCaptionProvider(
    async () =>
      new Response(
        'var ytInitialPlayerResponse=' +
          JSON.stringify({
            playabilityStatus: {
              status: 'LOGIN_REQUIRED',
              reason: 'Sign in to confirm you’re not a bot',
            },
          }) +
          ';',
      ),
  );
  expect((await provider.list_tracks(item, context())).status).toBe(
    'IP_BLOCKED',
  );
  expect(playerFromWatchPage(page()).videoDetails).toBeDefined();
});
it('distinguishes absent captions, required consent and geographic restrictions', async () => {
  for (const [text, status] of [
    [page(false), 'NO_CAPTIONS'],
    ['action="https://consent.youtube.com/s"', 'AUTH_REQUIRED'],
    [
      'var ytInitialPlayerResponse={"playabilityStatus":{"status":"UNPLAYABLE","reason":"Not available in your country"}};',
      'REGION_BLOCKED',
    ],
  ] as const) {
    expect(
      (
        await new YouTubeWebCaptionProvider(
          async () => new Response(text),
        ).list_tracks(item, context())
      ).status,
    ).toBe(status);
  }
});
it('stops before a proof-of-origin protected caption request and rejects SSRF/translated URLs', async () => {
  let calls = 0;
  const provider = new YouTubeWebCaptionProvider(async () => {
    calls++;
    return new Response(page(true, '&exp=xpe'));
  });
  const list = await provider.list_tracks(item, context());
  expect(
    (await provider.fetch(item, list.tracks[0]!, context())).result
      .failure_code,
  ).toBe('PROOF_OF_ORIGIN_REQUIRED');
  expect(calls).toBe(1);
  const poisoned = page().replace(
    'https://www.youtube.com/api/timedtext',
    'https://private.invalid/api/timedtext',
  );
  expect(
    (
      await new YouTubeWebCaptionProvider(
        async () => new Response(poisoned),
      ).list_tracks(item, context())
    ).status,
  ).toBe('PARSE_ERROR');
});
it('uses official editor-scoped API, manual/automatic metadata and every SRT cue without translation', async () => {
  const srt =
    '1\r\n00:00:00,000 --> 00:00:01,000\r\nFirst 😀\r\n\r\n2\r\n00:00:01,000 --> 00:00:02,000\r\nLast caveat.\r\n';
  const calls: string[] = [];
  const provider = new YouTubeCaptionProvider(
    async () => 'fixture-token',
    async (input, init) => {
      const u = new URL(String(input));
      calls.push(u.pathname);
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer fixture-token',
      );
      expect(u.searchParams.has('tlang')).toBe(false);
      if (u.pathname.endsWith('/videos'))
        return Response.json({
          items: [
            { id: item.external_id, snippet: { defaultAudioLanguage: 'en' } },
          ],
        });
      if (u.pathname.endsWith('/captions'))
        return Response.json({
          items: [
            {
              id: 'track',
              snippet: {
                videoId: item.external_id,
                language: 'en',
                trackKind: 'standard',
                status: 'serving',
                isDraft: false,
              },
            },
          ],
        });
      return new Response(srt);
    },
  );
  const list = await provider.list_tracks(
      item,
      context(youtubeCaptionProviderVersion),
    ),
    result = await provider.fetch(
      item,
      list.tracks[0]!,
      context(youtubeCaptionProviderVersion),
    );
  expect(list.tracks[0]!.is_original).toBe(true);
  expect(result.result.segments).toEqual(parseCaptionSrt(srt));
  expect(result.result.raw_payload_hash).toBe(await sha256(srt));
  expect(calls).toHaveLength(3);
  expect(() => parseCaptionSrt(srt + '\nmalformed tail')).toThrow();
});
it('pauses at 80% free budgets, stale telemetry, unknown CPU and every unqualified/paid source', () => {
  const now = new Date('2026-10-12T08:00:00Z');
  const sample: FreeTranscriptObservation = {
    sampled_at: now.toISOString(),
    quota_date_utc: '2026-10-12',
    plan: 'FREE',
    source_qualification: 'PASS',
    complete_pipeline_cpu_p99_ms: 7,
    workers_requests: 100,
    d1_rows_read: 100,
    d1_rows_written: 100,
    queue_operations: 100,
  };
  expect(freeTranscriptAdmission(sample, now).available).toBe(true);
  for (const change of [
    { plan: 'PAID' },
    { source_qualification: 'BLOCKED' },
    { complete_pipeline_cpu_p99_ms: null },
    { workers_requests: 80000 },
    { d1_rows_read: 4000000 },
    { d1_rows_written: 80000 },
    { queue_operations: 8000 },
    { sampled_at: '2026-10-12T07:00:00Z' },
    { quota_date_utc: '2026-10-11' },
  ])
    expect(
      freeTranscriptAdmission(
        { ...sample, ...change } as FreeTranscriptObservation,
        now,
      ).available,
    ).toBe(false);
  expect(freeTranscriptAdmission(null, now).additional_monthly_cost_pln).toBe(
    0,
  );
});
it('bounds Drive network requests and exports native Docs as text without a move/write operation', async () => {
  const calls: string[] = [];
  const client = new DriveClient(
    'fixture-token',
    async (input, init) => {
      const u = new URL(String(input));
      calls.push(u.pathname);
      expect(init?.method ?? 'GET').toBe('GET');
      return u.pathname.endsWith('/export')
        ? new Response('Complete native document')
        : Response.json({
            id: 'doc',
            name: 'BI-Daily-2026-10-11',
            mimeType: 'application/vnd.google-apps.document',
            trashed: false,
            parents: ['staging'],
            version: '1',
          });
    },
    2,
  );
  expect(await client.readDailyDocument('doc')).toBe(
    'Complete native document',
  );
  await expect(client.getFile('doc')).rejects.toBeInstanceOf(DriveBudgetWait);
  expect(calls).toHaveLength(2);
});
it.each(['unknown', 'exhausted'] as const)(
  'stops the cloud runner before token, network, lease or artifact work when free capacity is %s',
  async (state) => {
    const noWork = vi.fn(async () => {
      throw new Error('UNEXPECTED_EXTERNAL_OR_PAID_WORK');
    });
    const provider = new YouTubeCaptionProvider(noWork, noWork);
    const now = new Date();
    const observation: FreeTranscriptObservation | null =
      state === 'unknown'
        ? null
        : {
            sampled_at: now.toISOString(),
            quota_date_utc: now.toISOString().slice(0, 10),
            plan: 'FREE',
            source_qualification: 'PASS',
            complete_pipeline_cpu_p99_ms: 7,
            workers_requests: 80000,
            d1_rows_read: 0,
            d1_rows_written: 0,
            queue_operations: 0,
          };
    expect(
      await executeTranscript(
        item,
        context(youtubeCaptionProviderVersion),
        provider,
        { upload: noWork },
        {
          admission: noWork,
          heartbeat: noWork,
          outcome: noWork,
          diagnostic: noWork,
          accept: noWork,
        },
        60000,
        observation,
      ),
    ).toEqual({
      accepted: false,
      reason:
        state === 'unknown'
          ? 'UNQUALIFIED_FREE_REMOTE_SOURCE'
          : 'FREE_CAPACITY_PAUSED',
    });
    expect(noWork).not.toHaveBeenCalled();
  },
);
