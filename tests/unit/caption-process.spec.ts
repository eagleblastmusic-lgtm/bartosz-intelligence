import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
const processBoundary = vi.hoisted(() => ({
  execute: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: processBoundary.execute }));
import { runYtdlpProcess } from '../../apps/executor/src/providers/ytdlp.js';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
const request = {
  operation: 'list',
  item_id: '00000000-0000-4000-8000-000000000001',
  video_id: 'abcdefghijk',
  max_bytes: 4096,
} as const;
function child() {
  vi.stubEnv('BARTOSZ_PYTHON', resolve('fixture-python'));
  return Object.assign(new EventEmitter(), {
    stdin: { end: processBoundary.end, on: processBoundary.on },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
}
it('keeps the event loop responsive while the bounded private child is pending', async () => {
  vi.stubEnv('GEMINI_API_KEY', 'fixture-private-provider');
  vi.stubEnv('LOCAL_WORKER_CREDENTIAL', 'fixture-private-worker');
  const pendingChild = child();
  processBoundary.execute.mockReturnValue(pendingChild);
  let resolved = false;
  const pending = runYtdlpProcess(request, 3210).then((value) => {
    resolved = true;
    return value;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  expect(resolved).toBe(false);
  expect(processBoundary.end).toHaveBeenCalledWith(JSON.stringify(request));
  const [command, args, options] = processBoundary.execute.mock.calls[0]!;
  expect(command).toBe(resolve('fixture-python'));
  expect(args).toHaveLength(2);
  expect(args[0]).toBe('-B');
  expect(options).toMatchObject({
    windowsHide: true,
  });
  expect(options.env).not.toHaveProperty('GEMINI_API_KEY');
  expect(options.env).not.toHaveProperty('LOCAL_WORKER_CREDENTIAL');
  expect(options.env.PYTHONNOUSERSITE).toBe('1');
  pendingChild.stdout.emit('data', Buffer.from('{"status":"OK"}'));
  pendingChild.emit('close', 0);
  expect(await pending).toEqual({ status: 'OK' });
});
it('does not expose captured child stderr or malformed output through errors', async () => {
  const failedChild = child();
  processBoundary.execute.mockImplementation(() => {
    queueMicrotask(() => {
      failedChild.stderr.emit('data', Buffer.from('private captured stderr'));
      failedChild.emit('close', 9);
    });
    return failedChild;
  });
  await expect(runYtdlpProcess(request, 1000)).rejects.toThrow(
    'LOCAL_CAPTION_PROCESS_FAILURE',
  );
  const malformedChild = child();
  processBoundary.execute.mockImplementation(() => {
    queueMicrotask(() => {
      malformedChild.stdout.emit('data', Buffer.from('private invalid JSON'));
      malformedChild.emit('close', 0);
    });
    return malformedChild;
  });
  await expect(runYtdlpProcess(request, 1000)).rejects.toThrow(
    'LOCAL_CAPTION_PROCESS_FORMAT',
  );
});
