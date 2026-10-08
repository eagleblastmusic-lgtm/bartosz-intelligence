export function localWorkerConfiguration(args) {
  const modes = {
    '--analysis': ['local-analysis', 'LOCAL_AI_WORKER_CREDENTIAL', 'ANALYZE'],
    '--source-corrections': [
      'local-source-corrections',
      'LOCAL_CORRECTION_WORKER_CREDENTIAL',
      'NORMALIZE',
    ],
    '--search': ['local-search', 'LOCAL_SEARCH_WORKER_CREDENTIAL', 'PROJECT'],
  };
  if (args.length > 1 || (args.length && !Object.hasOwn(modes, args[0])))
    throw new Error('INVALID_LOCAL_WORKER_MODE');
  const [worker, variable, scope] = args.length
    ? modes[args[0]]
    : ['local-transcript', 'LOCAL_WORKER_CREDENTIAL', 'FETCH_TRANSCRIPT'];
  return { worker, variable, scopes: [scope] };
}
