import { expect, it } from 'vitest';
import { localWorkerConfiguration } from '../../tools/deployment/local-worker-config.mjs';
it.each([
  [[], 'local-transcript', 'LOCAL_WORKER_CREDENTIAL', 'FETCH_TRANSCRIPT'],
  [
    ['--oracle'],
    'oracle-frankfurt-transcript-1',
    'ORACLE_TRANSCRIPT_WORKER_CREDENTIAL',
    'FETCH_TRANSCRIPT',
  ],
  [['--analysis'], 'local-analysis', 'LOCAL_AI_WORKER_CREDENTIAL', 'ANALYZE'],
  [
    ['--source-corrections'],
    'local-source-corrections',
    'LOCAL_CORRECTION_WORKER_CREDENTIAL',
    'NORMALIZE',
  ],
  [['--search'], 'local-search', 'LOCAL_SEARCH_WORKER_CREDENTIAL', 'PROJECT'],
] as const)(
  'registers exactly one scoped service (%j)',
  (args, worker, variable, scope) => {
    expect(localWorkerConfiguration([...args])).toEqual({
      worker,
      variable,
      scopes: [scope],
    });
  },
);
it.each([
  ['--analysis', '--search'],
  ['--oracle', '--analysis'],
  ['--search', '--search'],
  ['--unknown'],
  ['--source-corrections', '--search'],
])('rejects ambiguous or unsupported service arguments (%j)', (...args) => {
  expect(() => localWorkerConfiguration(args)).toThrow(
    'INVALID_LOCAL_WORKER_MODE',
  );
});
