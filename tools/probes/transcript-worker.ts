import {
  YouTubeWebCaptionProvider,
  webCaptionProviderVersion,
} from '../../packages/core/src/transcript/providers/youtube-web.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
export default {
  async fetch(
    request: Request & { cf?: { colo?: string } },
    env: { PROBE_TOKEN: string },
  ) {
    const reply = (body: unknown, status = 200) =>
      Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
    if (
      !env.PROBE_TOKEN ||
      request.headers.get('Authorization') !== 'Bearer ' + env.PROBE_TOKEN
    )
      return reply({ code: 'UNAUTHORIZED' }, 401);
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/probe')
      return reply({ code: 'NOT_FOUND' }, 404);
    // Exactly one owner-specified known source; no public proxy/API service.
    const item = {
      namespace: 'youtube' as const,
      item_id: 'probe-rUhllpnYWR8',
      external_id: 'rUhllpnYWR8',
      duration_ms: null,
    };
    const context = {
      job_id: 'cloud-probe',
      item_id: item.item_id,
      runtime_id: 'cloud' as const,
      deadline: new Date(Date.now() + 90000).toISOString(),
      max_bytes: 4 * 1024 * 1024,
      quota_reservation_id: null,
      provider_version: webCaptionProviderVersion,
      request_id: crypto.randomUUID(),
    };
    const provider = new YouTubeWebCaptionProvider(),
      list = await provider.list_tracks(item, context);
    const base = {
      runtime: 'CLOUDFLARE_REMOTE',
      colo: request.cf?.colo ?? null,
      video_id: item.external_id,
      provider_version: webCaptionProviderVersion,
      listed_at: list.retrieved_at,
      status: list.status,
      reason: list.failure_code,
      tracks: list.tracks.map((t) => ({
        language: t.language_code,
        kind: t.track_kind,
      })),
      production_ready: false,
    };
    if (list.status !== 'OK') return reply(base);
    const track =
      list.tracks.find(
        (t) => t.language_code === 'en' && t.track_kind === 'MANUAL',
      ) ??
      list.tracks.find((t) => t.language_code === 'en') ??
      list.tracks[0]!;
    const fetched = await provider.fetch(item, track, context),
      result = fetched.result;
    if (result.status !== 'OK')
      return reply({
        ...base,
        status: result.status,
        reason: result.failure_code,
        last_response: provider.lastResponse,
      });
    const source = result.segments.map((s) => s.text).join('\n');
    // Returned only over the authenticated, temporary preview tunnel; caller
    // stores source privately and emits only hashes/counts in public evidence.
    return reply({
      ...base,
      status: result.status,
      reason: null,
      source_sha256: await sha256(source),
      raw_sha256: result.raw_payload_hash,
      source_bytes: new TextEncoder().encode(source).length,
      segment_count: result.segments.length,
      segments: result.segments,
    });
  },
};
