import { WorkerRpc } from './worker-rpc.js';
export class LocalSearchWorker {
  private rpc: WorkerRpc;
  private heartbeatAt = Number.NEGATIVE_INFINITY;
  constructor(
    origin: string,
    credential: string,
    transport: typeof fetch = fetch,
    private clock: () => number = Date.now,
  ) {
    this.rpc = new WorkerRpc(origin, credential, transport);
  }
  async cycle() {
    const now = this.clock();
    if (now - this.heartbeatAt >= 60000) {
      await this.rpc.request('heartbeat', { runtime: 'local' });
      this.heartbeatAt = now;
    }
    const result = (await this.rpc.request('search/step', {})) as {
      progressed?: unknown;
      phase?: unknown;
      projection_completed?: unknown;
    };
    if (
      typeof result.progressed !== 'boolean' ||
      !['BUILDING', 'CLEANUP', 'COMPLETE'].includes(String(result.phase)) ||
      (result.projection_completed !== undefined &&
        typeof result.projection_completed !== 'boolean')
    )
      throw new Error('INVALID_INDEX_RESPONSE');
    return {
      accepted: result.projection_completed === true,
      idle: !result.progressed,
    };
  }
}
