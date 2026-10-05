import {
  extractPlayerResponse,
  readLimited,
  sha256Bytes,
  probeDirectCaptions,
} from './direct-captions-core.js';

// Temporary measurement-only Preview; never a production route.
export default {
  async fetch(
    request: Request,
    env: { GATE0_BENCH_TOKEN?: string },
  ): Promise<Response> {
    if (request.method !== 'POST')
      return new Response('not found', { status: 404 });
    const input = (await request.json()) as {
      token?: string;
      mode?: string;
      request_id?: string;
      video_id?: string;
    };
    if (!env.GATE0_BENCH_TOKEN || input.token !== env.GATE0_BENCH_TOKEN)
      return new Response('not found', { status: 404 });
    const mode = input.mode;
    if (
      !['control', 'hash', 'decode', 'extract', 'body', 'live'].includes(
        mode ?? '',
      )
    )
      return new Response('invalid', { status: 400 });
    if (mode === 'live') {
      if (!input.video_id || !/^[\w-]{11}$/.test(input.video_id))
        return new Response('invalid', { status: 400 });
      const result = await probeDirectCaptions({
        video_id: input.video_id,
        request_id: input.request_id ?? 'cpu-retest',
        language_code: 'en',
        kind: 'manual',
        duration_seconds: 792,
      });
      console.log({
        cpu_experiment: mode,
        request_id: input.request_id,
        status: result.status,
        bytes: result.upstream_bytes_received,
      });
      return Response.json(result);
    }
    const prefix =
      '<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED"}};</script>';
    const html = prefix + ' '.repeat(1316765 - prefix.length);
    let bytes: Uint8Array | undefined;
    if (mode === 'hash' || mode === 'decode' || mode === 'body')
      bytes = new TextEncoder().encode(html);
    if (mode === 'hash') await sha256Bytes(bytes!);
    if (mode === 'decode') new TextDecoder().decode(bytes!);
    if (mode === 'extract') extractPlayerResponse(html);
    if (mode === 'body') {
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes!.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes!.subarray(offset, offset + 1024));
          offset += 1024;
        },
      });
      await readLimited(new Response(stream), 5 * 1024 * 1024);
    }
    console.log({
      cpu_experiment: mode,
      request_id: input.request_id,
      synthetic_bytes: 1316765,
    });
    return Response.json({
      mode,
      request_id: input.request_id,
      synthetic: true,
    });
  },
};
