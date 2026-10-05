import { probeDirectCaptions } from './direct-captions-core.js';

interface ProbeInput {
  manifest_sha256: string;
  request_id: string;
  video_id: string;
  language_code: string;
  kind: 'manual' | 'generated';
  duration_seconds: number;
  gate0_runner_token?: string;
}

interface Env {
  GATE0_BENCH_TOKEN?: string;
}

const MAX_REQUEST_BYTES = 8 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/probe')
      return new Response('not found', { status: 404 });
    const declaredLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES)
      return new Response('request too large', { status: 413 });
    let input: ProbeInput;
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_REQUEST_BYTES)
        return new Response('request too large', { status: 413 });
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!isProbeInput(value))
        return new Response('invalid request', { status: 400 });
      input = value;
    } catch {
      return new Response('invalid request', { status: 400 });
    }
    const expectedToken = env.GATE0_BENCH_TOKEN;
    if (
      !expectedToken ||
      typeof input.gate0_runner_token !== 'string' ||
      input.gate0_runner_token !== expectedToken
    )
      return new Response('not found', { status: 404 });
    const probeInput = {
      video_id: input.video_id,
      request_id: input.request_id,
      language_code: input.language_code,
      kind: input.kind,
      duration_seconds: input.duration_seconds,
    };
    const result = await probeDirectCaptions(
      {
        video_id: probeInput.video_id,
        request_id: probeInput.request_id,
        language_code: probeInput.language_code,
        kind: probeInput.kind,
        duration_seconds: probeInput.duration_seconds,
      },
      fetch,
    );
    // Never log caption URLs, response bodies, transcript text, or request headers.
    console.log({
      gate0: 'direct-captions-edge',
      request_id: result.request_id,
      video_id: result.video_id,
      manifest_sha256: input.manifest_sha256,
      status: result.status,
      reason_code: result.reason_code,
      watch_http_status: result.watch_http_status,
      caption_http_status: result.caption_http_status,
      upstream_bytes_received: result.upstream_bytes_received,
    });
    return Response.json(result, {
      headers: {
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
      },
    });
  },
};

function isProbeInput(value: unknown): value is ProbeInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.manifest_sha256 === 'string' &&
    HASH_PATTERN.test(input.manifest_sha256) &&
    typeof input.request_id === 'string' &&
    /^[\w-]{1,96}$/.test(input.request_id) &&
    typeof input.video_id === 'string' &&
    /^[\w-]{11}$/.test(input.video_id) &&
    typeof input.language_code === 'string' &&
    /^[\w-]{2,12}$/.test(input.language_code) &&
    (input.kind === 'manual' || input.kind === 'generated') &&
    typeof input.duration_seconds === 'number' &&
    Number.isFinite(input.duration_seconds) &&
    input.duration_seconds > 0 &&
    input.duration_seconds <= 60 * 60 * 24 &&
    (input.gate0_runner_token === undefined ||
      (typeof input.gate0_runner_token === 'string' &&
        /^[A-Za-z0-9_-]{40,64}$/.test(input.gate0_runner_token)))
  );
}
