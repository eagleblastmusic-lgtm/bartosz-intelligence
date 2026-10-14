import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { oracleCaptionRunner } from '../../apps/executor/src/providers/oracle-captions.js';
import {
  YtdlpTranscriptProvider,
  ytdlpProviderVersion,
} from '../../apps/executor/src/providers/ytdlp.js';
import { selectTranscriptLanguage } from '../../packages/core/src/transcript/language.js';

vi.mock('node:net', () => ({ createConnection: vi.fn() }));

class BrokerConnection extends EventEmitter {
  write = vi.fn();
  destroy = vi.fn(() => {
    this.emit('close');
    return this;
  });
}

const input = {
  operation: 'list' as const,
  item_id: '00000000-0000-4000-8000-000000000001',
  video_id: 'fixture0001',
  max_bytes: 4096,
};
let connection: BrokerConnection;

beforeEach(() => {
  vi.useFakeTimers();
  connection = new BrokerConnection();
  vi.mocked(createConnection).mockReturnValue(connection as unknown as Socket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('sends only the existing provider request and accepts fragmented broker JSON', async () => {
  const pending = oracleCaptionRunner(resolve('caption.sock'))(input, 2000);
  connection.emit('connect');
  expect(connection.write).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify(input) + '\n',
  );
  connection.emit('data', Buffer.from('{"status":"AUTH_'));
  connection.emit(
    'data',
    Buffer.from('REQUIRED","failure_code":"SESSION_EXPIRED"}\n'),
  );
  connection.emit('end');
  await expect(pending).resolves.toEqual({
    status: 'AUTH_REQUIRED',
    failure_code: 'SESSION_EXPIRED',
  });
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects malformed or oversized responses without exposing response bytes', async () => {
  for (const body of [
    Buffer.from('private signed URL is not JSON'),
    Buffer.alloc(32 * 1024 * 1024 + 1, 120),
  ]) {
    connection = new BrokerConnection();
    vi.mocked(createConnection).mockReturnValue(
      connection as unknown as Socket,
    );
    const pending = oracleCaptionRunner(resolve('caption.sock'))(input, 2000);
    const rejected = expect(pending).rejects.toThrow(
      'LOCAL_CAPTION_PROCESS_FAILURE',
    );
    connection.emit('data', body);
    connection.emit('end');
    await rejected;
    expect(connection.destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  }
});

it('settles immediately when the broker disconnects before a complete response', async () => {
  const settled = vi.fn();
  const pending = oracleCaptionRunner(resolve('caption.sock'))(input, 2000);
  void pending.catch(settled);
  connection.emit('data', Buffer.from('{"status":'));
  connection.emit('close');
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'LOCAL_CAPTION_PROCESS_FAILURE' }),
  );
  expect(vi.getTimerCount()).toBe(0);
});

it('aborts the connection and cannot dispatch a late request after cancellation', async () => {
  const shutdown = new AbortController();
  const pending = oracleCaptionRunner(resolve('caption.sock'))(
    input,
    2000,
    shutdown.signal,
  );
  const rejected = expect(pending).rejects.toThrow(
    'LOCAL_CAPTION_PROCESS_FAILURE',
  );
  shutdown.abort();
  connection.emit('connect');
  await rejected;
  expect(connection.destroy).toHaveBeenCalled();
  expect(connection.write).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds a silent broker and avoids connecting when cancellation already occurred', async () => {
  const runner = oracleCaptionRunner(resolve('caption.sock'));
  const pending = runner(input, 20);
  const rejected = expect(pending).rejects.toThrow(
    'LOCAL_CAPTION_PROCESS_FAILURE',
  );
  await vi.advanceTimersByTimeAsync(20);
  await rejected;
  expect(connection.destroy).toHaveBeenCalled();
  vi.mocked(createConnection).mockClear();
  await expect(runner(input, 20, AbortSignal.abort())).rejects.toThrow(
    'LOCAL_CAPTION_PROCESS_FAILURE',
  );
  expect(createConnection).not.toHaveBeenCalled();
});

it('core chooses the same captured regional manual track for the authoritative item identity', async () => {
  const at = new Date('2026-10-14T00:00:00.000Z');
  const provider = new YtdlpTranscriptProvider(
    async () => ({
      status: 'OK',
      failure_code: null,
      provider_version: '2026.8.19',
      python_version: '3.12.3',
      video_language: 'en',
      tracks: ['en', 'en-GB'].map((language_code) => ({
        language_code,
        track_kind: 'MANUAL',
        is_generated: false,
        is_translated: false,
        is_original: null,
        is_translatable: null,
        source_language: null,
        translation_languages: [],
        extension: 'json3',
      })),
    }),
    () => at,
  );
  const list = await provider.list_tracks(
    {
      item_id: input.item_id,
      namespace: 'youtube',
      external_id: input.video_id,
      duration_ms: null,
    },
    {
      job_id: 'fixture-job',
      item_id: input.item_id,
      runtime_id: 'local',
      deadline: new Date(at.getTime() + 60000).toISOString(),
      max_bytes: input.max_bytes,
      quota_reservation_id: null,
      provider_version: ytdlpProviderVersion,
      request_id: 'fixture-request',
    },
  );
  expect(selectTranscriptLanguage(list, '0'.repeat(64)).source).toMatchObject({
    language_code: 'en-GB',
    track_kind: 'MANUAL',
    track_id:
      '4a2a720787b44c6451c01675d5c734c813730997bb7e0ca75bfd23895f2daf28',
  });
});
