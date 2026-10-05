import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extractPlayerResponse,
  listPublicCaptionTracks,
  parseJson3CaptionCues,
  probeDirectCaptions,
  sha256Bytes,
} from '../../tools/gates/adapters/direct-captions-core.js';
import edgeWorker from '../../tools/gates/adapters/direct-captions-edge-worker.js';

const playerFixture = JSON.parse(
  readFileSync(
    new URL('../fixtures/gate0/player-response.json', import.meta.url),
    'utf8',
  ),
) as Record<string, unknown>;
const json3Fixture = readFileSync(
  new URL('../fixtures/gate0/captions-json3.json', import.meta.url),
  'utf8',
);
const videoId = 'uEztHu4NHrs';
const request = {
  video_id: videoId,
  request_id: 'fixture-1',
  language_code: 'en',
  kind: 'manual' as const,
  duration_seconds: 792,
};

function playerHtml(value: unknown): string {
  return `<script>var ytInitialPlayerResponse = ${JSON.stringify(value)};</script>`;
}

describe('Direct Captions Edge parser harness', () => {
  it('hashes only the view bytes and keeps localized login refusals distinct', async () => {
    const backing = new Uint8Array([0, 65, 66, 0]);
    expect(await sha256Bytes(backing.subarray(1, 3))).toBe(
      await sha256Bytes(new Uint8Array([65, 66])),
    );
    const result = await probeDirectCaptions(
      request,
      async () =>
        new Response(
          playerHtml({
            playabilityStatus: {
              status: 'LOGIN_REQUIRED',
              reason: 'Zaloguj się',
            },
          }),
        ),
    );
    expect(result.status).toBe('AUTH_REQUIRED');
    expect(result.reason_code).toBe('PLAYABILITY_LOGIN_REQUIRED');
  });
  it('rejects public preview probes without the ephemeral runner token', async () => {
    const response = await edgeWorker.fetch(
      new Request('https://preview.invalid/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          manifest_sha256: 'a'.repeat(64),
          ...request,
          request_id: 'fixture-unauthorized',
          gate0_runner_token: 'x'.repeat(43),
        }),
      }),
      {},
    );
    expect(response.status).toBe(404);
  });

  it('extracts the balanced player JSON and classifies manual/generated tracks', () => {
    const parsed = extractPlayerResponse(playerHtml(playerFixture));
    expect(parsed?.videoDetails).toMatchObject({ videoId });
    const tracks = listPublicCaptionTracks(parsed!);
    expect(
      tracks?.map(({ language_code, kind, is_translatable }) => ({
        language_code,
        kind,
        is_translatable,
      })),
    ).toEqual([
      { language_code: 'en', kind: 'manual', is_translatable: true },
      { language_code: 'en', kind: 'generated', is_translatable: false },
    ]);
    expect(extractPlayerResponse('<html>no player object</html>')).toBeNull();
  });

  it('parses JSON3 cue timestamps and unescaped UTF-8 text without fabricating time', async () => {
    const cues = await parseJson3CaptionCues(json3Fixture);
    expect(cues).toHaveLength(3);
    expect(cues?.[0]).toMatchObject({ start_ms: 0, end_ms: 1200 });
    expect(cues?.[1]).toMatchObject({ start_ms: 1350, end_ms: 2300 });
    expect(cues?.[2]).toMatchObject({ start_ms: 2600, end_ms: 3100 });
    expect(await parseJson3CaptionCues('{malformed')).toBeNull();
    expect(
      await parseJson3CaptionCues(
        JSON.stringify({ events: [{ segs: [{ utf8: 'missing time' }] }] }),
      ),
    ).toBeNull();
  });

  it('captures HTTP shape and hashes while excluding signed caption URLs and text', async () => {
    const calls: string[] = [];
    const fetchFixture: typeof fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url.href);
      if (url.pathname === '/watch')
        return new Response(playerHtml(playerFixture), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      return new Response(json3Fixture, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    };
    const result = await probeDirectCaptions(request, fetchFixture);
    expect(result).toMatchObject({
      status: 'OK',
      watch_http_status: 200,
      watch_content_type: 'text/html',
      caption_http_status: 200,
      caption_content_type: 'application/json',
      track_count: 2,
      cue_count: 3,
      within_duration: true,
    });
    expect(result.watch_response_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.caption_response_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.first_cue?.start_ms).toBe(0);
    expect(result.last_cue?.end_ms).toBe(3100);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('fmt=json3');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('fixture-signature');
    expect(serialized).not.toContain('Hello & welcome');
    expect(serialized).not.toContain('base_url');
  });

  it('reports natural no-caption only for a successful public page with empty tracks', async () => {
    const emptyTrackPlayer = {
      playabilityStatus: { status: 'OK' },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
    };
    const result = await probeDirectCaptions(
      request,
      async () =>
        new Response(playerHtml(emptyTrackPlayer), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    expect(result.status).toBe('NO_CAPTIONS');
    expect(result.watch_http_status).toBe(200);
    expect(result.track_count).toBe(0);
    expect(result.reason_code).toBe('EMPTY_PUBLIC_TRACKLIST');
  });

  it('keeps provider HTTP failures separate and never retries inside one probe', async () => {
    const calls: string[] = [];
    const result = await probeDirectCaptions(request, async (input) => {
      calls.push(String(input));
      return new Response('upstream unavailable', { status: 503 });
    });
    expect(result.status).toBe('TEMPORARY_FAILURE');
    expect(result.watch_http_status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it('retains upstream Retry-After and labels 429 as rate-limited', async () => {
    const result = await probeDirectCaptions(
      request,
      async () =>
        new Response('slow down', {
          status: 429,
          headers: { 'retry-after': '120' },
        }),
    );
    expect(result.status).toBe('RATE_LIMITED');
    expect(result.watch_retry_after).toBe('120');
    expect(result.caption_http_status).toBeNull();
  });

  it('rejects oversized upstream responses before parsing them', async () => {
    const result = await probeDirectCaptions(
      request,
      async () =>
        new Response('x', {
          status: 200,
          headers: {
            'content-type': 'text/html',
            'content-length': String(6 * 1024 * 1024),
          },
        }),
    );
    expect(result.status).toBe('TOO_LARGE');
    expect(result.reason_code).toBe('RESPONSE_SIZE_LIMIT');
  });

  it('rejects caption URLs outside the public YouTube origin', () => {
    const hostile = structuredClone(playerFixture) as {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: Array<Record<string, unknown>>;
        };
      };
    };
    hostile.captions.playerCaptionsTracklistRenderer.captionTracks[0]!.baseUrl =
      'https://example.invalid/caption?sig=must-not-fetch';
    expect(listPublicCaptionTracks(hostile)).toBeNull();
  });
});
