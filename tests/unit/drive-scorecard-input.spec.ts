import { afterEach, expect, it, vi } from 'vitest';
const files = vi.hoisted(() => ({
  read: vi.fn(),
  stat: vi.fn(),
  write: vi.fn(),
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  readFileSync: files.read,
  statSync: files.stat,
  writeFileSync: files.write,
}));
import { runDriveScorecard } from '../../tools/gates/drive-scorecard.js';
const argv = process.argv;
const exitCode = process.exitCode;
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function run() {
  process.argv = [
    'node',
    'drive-export.ts',
    '--manifest',
    'input.json',
    '--output',
    'report.json',
  ];
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  runDriveScorecard('D_EXPORT');
  expect(process.exitCode).toBe(2);
  expect(files.write.mock.calls[0]?.[2]).toEqual({ flag: 'wx' });
  return JSON.parse(files.write.mock.calls[0]![1]);
}
it('rejects oversized inputs and nonregular files before reading any bytes', () => {
  files.stat.mockReturnValue({ size: 256 * 1024 + 1, isFile: () => true });
  expect(run().reason).toBe('DRIVE_GATE_INPUT_TOO_LARGE');
  expect(files.read).not.toHaveBeenCalled();
  files.write.mockClear();
  files.stat.mockReturnValue({ size: 0, isFile: () => false });
  expect(run().reason).toBe('DRIVE_GATE_INPUT_NOT_FILE');
  expect(files.read).not.toHaveBeenCalled();
});
it('retains the post-read limit when an input grows after stat', () => {
  files.stat.mockReturnValue({ size: 10, isFile: () => true });
  files.read.mockReturnValue(Buffer.alloc(256 * 1024 + 1));
  expect(run().reason).toBe('DRIVE_GATE_INPUT_TOO_LARGE');
  expect(files.read).toHaveBeenCalledTimes(1);
});
