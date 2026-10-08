import { expect, it } from 'vitest';
import { boundedText } from '../../packages/core/src/http/bounded-text.js';
import { YoutubeClient } from '../../packages/core/src/sources/youtube/client.js';
import { pollRss } from '../../packages/core/src/sources/youtube/rss.js';
it('bounds UTF-8 bytes and preserves multibyte characters across chunks', async () => {
  const bytes = new TextEncoder().encode('żółć');
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1));
        controller.enqueue(bytes.slice(1));
        controller.close();
      },
    }),
  );
  expect(await boundedText(response, bytes.length)).toBe('żółć');
});
it('cancels an oversized chunked body before consuming the rest', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(9));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await expect(boundedText(response, 8)).rejects.toThrow(
    'RESPONSE_BODY_TOO_LARGE',
  );
  expect(cancelled).toBe(true);
});
it('checks declared size and invalid UTF-8 without exposing content', async () => {
  await expect(
    boundedText(new Response('x', { headers: { 'Content-Length': '999' } }), 8),
  ).rejects.toThrow('RESPONSE_BODY_TOO_LARGE');
  await expect(
    boundedText(new Response(new Uint8Array([255])), 8),
  ).rejects.toThrow('RESPONSE_INVALID_UTF8');
});
it('enforces the bound in the real YouTube client without another request', async () => {
  let calls = 0,
    cancelled = false;
  const client = new YoutubeClient('synthetic-key', 1, async () => {
    calls++;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(512001));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  await expect(client.get('videos', { id: 'abcdefghijk' })).rejects.toThrow(
    'PARSER',
  );
  expect(calls).toBe(1);
  expect(cancelled).toBe(true);
});
it('classifies body transport failure separately from parsing and bounds RSS too', async () => {
  const client = new YoutubeClient(
    'synthetic-key',
    1,
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('private-network-diagnostic'));
          },
        }),
      ),
  );
  await expect(client.get('videos', {})).rejects.toThrow('TRANSIENT');
  await expect(
    pollRss(
      'UC' + 'a'.repeat(22),
      null,
      null,
      async () => new Response('x'.repeat(64001)),
    ),
  ).rejects.toThrow('RESPONSE_BODY_TOO_LARGE');
});
