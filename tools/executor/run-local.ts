import { setTimeout as delay } from 'node:timers/promises';
import { LocalTranscriptWorker } from '../../apps/executor/src/local-worker.js';
import { WorkerRpcError } from '../../apps/executor/src/worker-rpc.js';
import { LocalAnalysisWorker } from '../../apps/executor/src/analysis-worker.js';
import { LocalSourceCorrectionWorker } from '../../apps/executor/src/source-correction-worker.js';
import { LocalSearchWorker } from '../../apps/executor/src/search-worker.js';
import { LocalOptionalAIWorker } from '../../apps/executor/src/optional-worker.js';
const analysis = process.argv.includes('--analysis');
const corrections = process.argv.includes('--source-corrections');
const search = process.argv.includes('--search');
const translation = process.argv.includes('--translation'),
  history = process.argv.includes('--history');
if (
  [analysis, corrections, search, translation, history].filter(Boolean).length >
  1
)
  throw new Error('INVALID_EXECUTOR_MODE');
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
const once = process.argv.includes('--once');
let stopped = false;
let active = false;
process.on('SIGINT', () => {
  stopped = true;
});
process.on('SIGTERM', () => {
  stopped = true;
});
do {
  try {
    const result = await worker.cycle();
    active = !result.idle;
    process.stdout.write(
      JSON.stringify({
        event: 'LOCAL_EXECUTOR_CYCLE',
        accepted: result.accepted,
        idle: result.idle,
      }) + '\n',
    );
  } catch (error) {
    active = false;
    // Never print exception stacks, provider bodies, credentials or input text.
    const denied =
      error instanceof Error && error.message === 'EXECUTOR_AUTH_DENIED';
    process.stderr.write(
      JSON.stringify({
        event: denied
          ? 'LOCAL_EXECUTOR_AUTH_DENIED'
          : 'LOCAL_EXECUTOR_CYCLE_FAILED',
        ...(error instanceof WorkerRpcError
          ? { route: error.route, status: error.status }
          : {}),
      }) + '\n',
    );
    if (denied || once) {
      process.exitCode = 1;
      break;
    }
  }
  if (!once && !stopped) await delay(search && active ? 250 : 30000);
} while (!once && !stopped);
