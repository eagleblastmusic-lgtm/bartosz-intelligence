import { expect, it } from 'vitest';
import { readCapacityPage } from '../../tools/gates/capacity/page.js';

it('reads valid UTF-8 telemetry across arbitrary chunk boundaries', async () => {
  const bytes = new TextEncoder().encode('{"sample":"ł","cases":[]}');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  expect(await readCapacityPage(new Response(stream))).toEqual({
    sample: 'ł',
    cases: [],
  });
});

it('cancels oversized declared and undeclared telemetry bodies', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(256 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readCapacityPage(
        new Response(stream, {
          headers: declared ? { 'Content-Length': String(256 * 1024 + 1) } : {},
        }),
      ),
    ).rejects.toThrow('CAPACITY_PAGE_TOO_LARGE');
    expect(cancelled).toBe(true);
  }
});

it('rejects malformed JSON and invalid UTF-8 without exposing the body', async () => {
  for (const body of ['private response body', new Uint8Array([0xff])]) {
    await expect(readCapacityPage(new Response(body))).rejects.toThrow(
      'INVALID_CAPACITY_COLLECTION_PAGE',
    );
  }
});
