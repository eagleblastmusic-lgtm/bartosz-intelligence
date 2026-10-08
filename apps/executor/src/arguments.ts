export function executorArguments(args: string[]) {
  const modes = [
    '--analysis',
    '--source-corrections',
    '--search',
    '--translation',
    '--history',
  ] as const;
  let mode: (typeof modes)[number] | null = null;
  let once = false;
  let jobId: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (modes.includes(argument as (typeof modes)[number])) {
      if (mode) throw new Error('INVALID_EXECUTOR_MODE');
      mode = argument as (typeof modes)[number];
    } else if (argument === '--once') {
      if (once) throw new Error('INVALID_EXECUTOR_ARGUMENT');
      once = true;
    } else if (argument === '--job-id') {
      if (jobId !== undefined) throw new Error('INVALID_ANALYSIS_JOB_ID');
      jobId = args[++index];
      if (
        !jobId ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          jobId,
        )
      )
        throw new Error('INVALID_ANALYSIS_JOB_ID');
    } else throw new Error('INVALID_EXECUTOR_ARGUMENT');
  }
  if (jobId && (mode !== '--analysis' || !once))
    throw new Error('INVALID_ANALYSIS_JOB_ID');
  return { mode, once, jobId };
}
