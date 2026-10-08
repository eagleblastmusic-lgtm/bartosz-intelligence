import { LocalTranscriptWorker } from '../../apps/executor/src/local-worker.js';
import { runExecutorLoop } from '../../apps/executor/src/cycle-loop.js';
import { LocalAnalysisWorker } from '../../apps/executor/src/analysis-worker.js';
import { LocalSourceCorrectionWorker } from '../../apps/executor/src/source-correction-worker.js';
import { LocalSearchWorker } from '../../apps/executor/src/search-worker.js';
import { LocalOptionalAIWorker } from '../../apps/executor/src/optional-worker.js';
import { executorArguments } from '../../apps/executor/src/arguments.js';
const {
  mode,
  once,
  jobId: selectedJob,
} = executorArguments(process.argv.slice(2));
const analysis = mode === '--analysis';
const corrections = mode === '--source-corrections';
const search = mode === '--search';
const translation = mode === '--translation',
  history = mode === '--history';
const origin = process.env.APP_ORIGIN,
  credential =
    translation || history
      ? process.env.LOCAL_OPTIONAL_AI_WORKER_CREDENTIAL
      : search
        ? process.env.LOCAL_SEARCH_WORKER_CREDENTIAL
        : corrections
          ? process.env.LOCAL_CORRECTION_WORKER_CREDENTIAL
          : analysis
            ? process.env.LOCAL_AI_WORKER_CREDENTIAL
            : process.env.LOCAL_WORKER_CREDENTIAL;
if (!origin || !credential)
  throw new Error('LOCAL_EXECUTOR_CONFIGURATION_REQUIRED');
const worker =
  translation || history
    ? new LocalOptionalAIWorker(
        translation ? 'TRANSLATE' : 'HISTORICAL_COMPARE',
        origin,
        credential,
        process.env.GEMINI_API_KEY ?? '',
      )
    : search
      ? new LocalSearchWorker(origin, credential)
      : corrections
        ? new LocalSourceCorrectionWorker(origin, credential)
        : analysis
          ? new LocalAnalysisWorker(
              origin,
              credential,
              process.env.GEMINI_API_KEY ?? '',
            )
          : new LocalTranscriptWorker(origin, credential);
const shutdown = new AbortController();
process.on('SIGINT', () => {
  shutdown.abort();
});
process.on('SIGTERM', () => {
  shutdown.abort();
});
const exitCode = await runExecutorLoop({
  cycle: () =>
    worker instanceof LocalAnalysisWorker
      ? worker.cycle(selectedJob)
      : worker.cycle(),
  once,
  search,
  signal: shutdown.signal,
  emit: (event, failure) =>
    (failure ? process.stderr : process.stdout).write(
      JSON.stringify(event) + '\n',
    ),
});
process.exitCode = exitCode === 1 && !once ? 78 : exitCode;
