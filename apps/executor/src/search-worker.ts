import { WorkerRpc } from './worker-rpc.js';
export class LocalSearchWorker {
  private rpc: WorkerRpc;
  constructor(
    origin: string,
    credential: string,
    transport: typeof fetch = fetch,
  ) {
    this.rpc = new WorkerRpc(origin, credential, transport);
  }
  async cycle() {
    const result = (await this.rpc.request('search/step', {})) as {
      progressed?: unknown;
      phase?: unknown;
    };
    if (
      typeof result.progressed !== 'boolean' ||
      !['BUILDING', 'CLEANUP', 'COMPLETE'].includes(String(result.phase))
    )
      throw new Error('INVALID_INDEX_RESPONSE');
    return { accepted: false, idle: !result.progressed };
  }
}
