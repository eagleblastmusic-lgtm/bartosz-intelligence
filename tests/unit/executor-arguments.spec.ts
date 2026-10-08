import { expect, it } from 'vitest';
import { executorArguments } from '../../apps/executor/src/arguments.js';
const id = '12345678-1234-1234-1234-123456789abc';
it('preserves default transcript and bounded selected analysis modes in any argument order', () => {
  expect(executorArguments([])).toEqual({
    mode: null,
    once: false,
    jobId: undefined,
  });
  expect(executorArguments(['--once', '--job-id', id, '--analysis'])).toEqual({
    mode: '--analysis',
    once: true,
    jobId: id,
  });
  for (const mode of [
    '--search',
    '--source-corrections',
    '--translation',
    '--history',
  ])
    expect(executorArguments([mode, '--once'])).toEqual({
      mode,
      once: true,
      jobId: undefined,
    });
});
it.each([
  ['--analyse'],
  ['--analysis', '--analysis'],
  ['--analysis', '--search'],
  ['--once', '--once'],
  ['--job-id'],
  ['--job-id', id],
  ['--analysis', '--job-id', id],
  ['--search', '--once', '--job-id', id],
  ['--analysis', '--once', '--job-id', id, '--job-id', id],
  ['--analysis', '--once', '--job-id', id, 'unexpected'],
])(
  'rejects ambiguous or invalid arguments before creating a worker (%j)',
  (...args) => {
    expect(() => executorArguments(args)).toThrow();
  },
);
