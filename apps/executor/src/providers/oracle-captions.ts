import { createConnection } from 'node:net';
import { isAbsolute } from 'node:path';
import type { CaptionProcessRunner } from './ytdlp.js';

/** Fixed local broker preserves the existing provider contract and job loop. */
export function oracleCaptionRunner(socketPath: string): CaptionProcessRunner {
  if (!isAbsolute(socketPath) || /[\r\n\0]/.test(socketPath))
    throw new Error('ORACLE_CAPTION_SOCKET_REQUIRED');
  return (input, timeoutMs, signal) =>
    new Promise((done, fail) => {
      if (signal?.aborted) {
        fail(new Error('LOCAL_CAPTION_PROCESS_FAILURE'));
        return;
      }
      const connection = createConnection(socketPath);
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const reject = () => {
        if (settled) return;
        settled = true;
        connection.destroy();
        fail(new Error('LOCAL_CAPTION_PROCESS_FAILURE'));
      };
      const timer = setTimeout(reject, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', reject);
      };
      signal?.addEventListener('abort', reject, { once: true });
      connection.once('connect', () => {
        if (!settled) connection.write(JSON.stringify(input) + '\n');
      });
      connection.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) reject();
        else chunks.push(chunk);
      });
      connection.once('error', () => {
        cleanup();
        reject();
      });
      connection.once('end', () => {
        if (settled) return;
        cleanup();
        try {
          const value: unknown = JSON.parse(
            Buffer.concat(chunks).toString('utf8'),
          );
          settled = true;
          done(value);
        } catch {
          reject();
        }
      });
      connection.once('close', () => {
        cleanup();
        reject();
      });
    });
}
