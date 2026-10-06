import { setTimeout as delay } from 'node:timers/promises';
import { LocalTranscriptWorker } from '../../apps/executor/src/local-worker.js';
import { WorkerRpcError } from '../../apps/executor/src/worker-rpc.js';
const origin = process.env.APP_ORIGIN,
  credential = process.env.LOCAL_WORKER_CREDENTIAL;
if (!origin || !credential)
  throw new Error('LOCAL_EXECUTOR_CONFIGURATION_REQUIRED');
const worker = new LocalTranscriptWorker(origin, credential);
const once = process.argv.includes('--once');
let stopped = false;
process.on('SIGINT', () => {
  stopped = true;
});
process.on('SIGTERM', () => {
  stopped = true;
});
do {
  try {
    const result = await worker.cycle();
    process.stdout.write(
      JSON.stringify({
        event: 'LOCAL_EXECUTOR_CYCLE',
        accepted: result.accepted,
        idle: result.idle,
      }) + '\n',
    );
  } catch (error) {
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
  if (!once && !stopped) await delay(30000);
} while (!once && !stopped);
