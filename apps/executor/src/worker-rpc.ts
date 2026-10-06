import { fetchWithoutRedirect } from '../../../packages/core/src/http/no-redirect.js';
export class WorkerRpcError extends Error {
  constructor(
    message: string,
    readonly route: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export class WorkerRpc {
  private origin: URL;
  constructor(
    origin: string,
    private credential: string,
    private transport: typeof fetch = fetch,
  ) {
    this.origin = new URL(origin);
    if (
      (this.origin.protocol !== 'https:' &&
        !(
          this.origin.protocol === 'http:' &&
          this.origin.hostname === '127.0.0.1'
        )) ||
      this.origin.username ||
      this.origin.password ||
      this.origin.pathname !== '/' ||
      this.origin.search ||
      this.origin.hash ||
      !/^[A-Za-z0-9_-]{43}$/.test(credential)
    )
      throw new Error('INVALID_EXECUTOR_CONNECTION');
  }
  async request(
    path: string,
    input: Record<string, unknown>,
    method: 'GET' | 'POST' = 'POST',
  ) {
    if (
      !/^(?:lease|heartbeat|start|retry|defer|analysis\/(?:input|context|reserve|submit|response|validate)|transcript\/(?:input|accept|outcome|admission)|artifacts\/(?:begin|write|read|verify-step))$/.test(
        path,
      )
    )
      throw new Error('INVALID_WORKER_ROUTE');
    const url = new URL('/internal/workers/' + path, this.origin);
    if (method === 'GET') {
      if (
        path !== 'transcript/admission' ||
        input.runtime !== 'local' ||
        Object.keys(input).length !== 1
      )
        throw new Error('INVALID_WORKER_QUERY');
      url.searchParams.set('runtime', 'local');
    }
    const response = await fetchWithoutRedirect(
      url.href,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + this.credential,
        },
        ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
        signal: AbortSignal.timeout(30000),
      },
      this.transport,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new WorkerRpcError(
        response.status === 401 || response.status === 403
          ? 'EXECUTOR_AUTH_DENIED'
          : response.status === 409
            ? 'STALE_FENCE'
            : 'WORKER_RPC_FAILED',
        path,
        response.status,
      );
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > 65536) {
      await response.body?.cancel();
      throw new Error('WORKER_RPC_TOO_LARGE');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('WORKER_RPC_EMPTY');
    const chunks: Uint8Array[] = [];
    let count = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      count += part.value.length;
      if (count > 65536) {
        await reader.cancel();
        throw new Error('WORKER_RPC_TOO_LARGE');
      }
      chunks.push(part.value);
    }
    const data = new Uint8Array(count);
    let offset = 0;
    for (const part of chunks) {
      data.set(part, offset);
      offset += part.length;
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data),
    ) as unknown;
  }
}
