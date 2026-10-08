import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import {
  localServices,
  serviceEnvironment,
  superviseService,
} from '../../apps/executor/src/services.js';

if (process.argv.length !== 2) throw new Error('UNSUPPORTED_SERVICE_ARGUMENT');
const selected = localServices.filter(
  (service) => !!process.env[service.credential],
);
if (!selected.length) throw new Error('LOCAL_SERVICE_CONFIGURATION_REQUIRED');
// Validate every configured service before starting any child.
const configured = selected.map((service) => ({
  service,
  environment: serviceEnvironment(service, process.env),
}));
const shutdown = new AbortController();
process.on('SIGINT', () => shutdown.abort());
process.on('SIGTERM', () => shutdown.abort());
const results = await Promise.all(
  configured.map(async ({ service, environment }) => {
    const emit = (event: string, code: number | null) =>
      process.stdout.write(
        JSON.stringify({
          event: 'LOCAL_SERVICE_' + event,
          service: service.name,
          code,
        }) + '\n',
      );
    return superviseService({
      signal: shutdown.signal,
      emit,
      wait: (milliseconds, signal) =>
        delay(milliseconds, undefined, { signal }),
      run: () =>
        new Promise((resolveExit) => {
          emit('START', null);
          const child = spawn(
            process.execPath,
            [
              '--import',
              'tsx',
              resolve('tools/executor/run-local.ts'),
              ...(service.flag ? [service.flag] : []),
            ],
            {
              cwd: process.cwd(),
              env: environment,
              windowsHide: true,
              // Startup exception bodies are not suitable for production logs.
              stdio: 'ignore',
            },
          );
          let killTimer: ReturnType<typeof setTimeout> | undefined;
          const stop = () => {
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), 30000);
          };
          shutdown.signal.addEventListener('abort', stop, { once: true });
          const cleanup = () => {
            shutdown.signal.removeEventListener('abort', stop);
            if (killTimer) clearTimeout(killTimer);
          };
          child.once('error', () => {
            cleanup();
            resolveExit({ code: 1, signal: null });
          });
          child.once('exit', (code, signal) => {
            cleanup();
            resolveExit({ code, signal });
          });
          if (shutdown.signal.aborted) stop();
        }),
    });
  }),
);
process.exitCode = results.some((code) => code !== 0) ? 1 : 0;
