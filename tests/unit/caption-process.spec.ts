import { afterEach, expect, it, vi } from 'vitest';
const processBoundary = vi.hoisted(() => ({
  execute: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFile: processBoundary.execute }));
import { runYtdlpProcess } from '../../apps/executor/src/providers/ytdlp.js';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
const request = {
  operation: 'list',
  video_id: 'abcdefghijk',
  max_bytes: 4096,
} as const;
it('keeps the event loop responsive while the bounded private child is pending', async () => {
  vi.stubEnv('GEMINI_API_KEY', 'fixture-private-provider');
  vi.stubEnv('LOCAL_WORKER_CREDENTIAL', 'fixture-private-worker');
  let complete!: (error: Error | null, stdout: string) => void;
  processBoundary.execute.mockImplementation(
    (_command, _args, _options, callback) => {
      complete = callback;
      return { stdin: { end: processBoundary.end, on: processBoundary.on } };
    },
  );
  let resolved = false;
  const pending = runYtdlpProcess(request, 3210).then((value) => {
    resolved = true;
    return value;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  expect(resolved).toBe(false);
  expect(processBoundary.end).toHaveBeenCalledWith(JSON.stringify(request));
  const [command, args, options] = processBoundary.execute.mock.calls[0]!;
  expect(command).toBe('python');
  expect(args).toHaveLength(1);
  expect(options).toMatchObject({
    timeout: 3210,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  expect(options.env).not.toHaveProperty('GEMINI_API_KEY');
  expect(options.env).not.toHaveProperty('LOCAL_WORKER_CREDENTIAL');
  expect(options.env.PYTHONNOUSERSITE).toBe('1');
  complete(null, '{"status":"OK"}');
  expect(await pending).toEqual({ status: 'OK' });
});
it('does not expose captured child stderr or malformed output through errors', async () => {
  processBoundary.execute.mockImplementation(
    (_command, _args, _options, callback) => {
      queueMicrotask(() =>
        callback(new Error('private captured stderr'), 'private stdout'),
      );
      return { stdin: { end: processBoundary.end, on: processBoundary.on } };
    },
  );
  await expect(runYtdlpProcess(request, 1000)).rejects.toThrow(
    'LOCAL_CAPTION_PROCESS_FAILURE',
  );
  processBoundary.execute.mockImplementation(
    (_command, _args, _options, callback) => {
      queueMicrotask(() => callback(null, 'private invalid JSON'));
      return { stdin: { end: processBoundary.end, on: processBoundary.on } };
    },
  );
  await expect(runYtdlpProcess(request, 1000)).rejects.toThrow(
    'LOCAL_CAPTION_PROCESS_FORMAT',
  );
});
