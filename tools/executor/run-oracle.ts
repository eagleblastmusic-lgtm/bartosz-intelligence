import {
  oracleConfiguration,
  verifyOracleRuntime,
} from '../../apps/executor/src/oracle-runtime.js';
import { LocalTranscriptWorker } from '../../apps/executor/src/local-worker.js';
import { runExecutorLoop } from '../../apps/executor/src/cycle-loop.js';
import {
  captionProcessRunner,
  YtdlpTranscriptProvider,
  ytdlpProviderVersion,
} from '../../apps/executor/src/providers/ytdlp.js';
import { oracleCaptionRunner } from '../../apps/executor/src/providers/oracle-captions.js';

// Only the existing transcript worker. No listener, local queue or AI credentials.
const shutdown = new AbortController();
process.on('SIGTERM', () => shutdown.abort());
process.on('SIGINT', () => shutdown.abort());
const emit = (event: Record<string, unknown>, failure = false) =>
  (failure ? process.stderr : process.stdout).write(
    JSON.stringify(event) + '\n',
  );
let started = false;
try {
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    (args.length === 1 && !['--check', '--once'].includes(args[0]!))
  )
    throw new Error('ORACLE_ARGUMENT_INVALID');
  const config = oracleConfiguration(process.env);
  await verifyOracleRuntime(config);
  emit({
    event: 'ORACLE_RUNTIME_READY',
    worker_id: config.workerId,
    concurrency: 1,
    source_qualified: config.sourceQualified,
  });
  if (args[0] !== '--check') {
    if (!config.sourceQualified) throw new Error('ORACLE_SOURCE_NOT_QUALIFIED');
    const worker = new LocalTranscriptWorker(
      config.origin,
      config.credential,
      new YtdlpTranscriptProvider(
        config.captionSocket
          ? oracleCaptionRunner(config.captionSocket)
          : captionProcessRunner(config),
        undefined,
        config.captionSocket ? 120000 : 60000,
      ),
      fetch,
      ytdlpProviderVersion,
      config.workerId,
    );
    started = true;
    const code = await runExecutorLoop({
      cycle: () =>
        worker.cycle(
          AbortSignal.any([shutdown.signal, AbortSignal.timeout(180000)]),
        ),
      once: args[0] === '--once',
      search: false,
      signal: shutdown.signal,
      emit: (event, failure) =>
        emit({ ...event, worker_id: config.workerId }, failure),
    });
    process.exitCode = code === 1 && args[0] !== '--once' ? 78 : code;
    emit({
      event: 'ORACLE_EXECUTOR_STOPPED',
      worker_id: config.workerId,
      exit_code: process.exitCode,
    });
  }
} catch (error) {
  // Never emit exception messages from processes, HTTP, configuration or secrets.
  const code =
    error instanceof Error && /^ORACLE_[A-Z_]+$/.test(error.message)
      ? error.message
      : 'ORACLE_RUNTIME_CHECK_FAILED';
  emit(
    {
      event: started
        ? 'ORACLE_EXECUTOR_FAILED'
        : 'ORACLE_CONFIGURATION_REJECTED',
      code,
    },
    true,
  );
  process.exitCode = started ? 1 : 78;
}
