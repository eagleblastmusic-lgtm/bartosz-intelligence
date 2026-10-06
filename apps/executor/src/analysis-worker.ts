import type {
  JobRecord,
  LeaseToken,
} from '../../../packages/contracts/src/jobs.js';
import { WorkerRpc, WorkerRpcError } from './worker-rpc.js';
import { executeLocalAnalysis } from './analysis-transport.js';

export class LocalAnalysisWorker {
  private rpc: WorkerRpc;
  constructor(
    private origin: string,
    private credential: string,
    private key: string,
    private transport: typeof fetch = fetch,
    private providerTransport: typeof fetch = fetch,
  ) {
    if (!key) throw new Error('AI_EXECUTOR_CONFIGURATION_REQUIRED');
    this.rpc = new WorkerRpc(origin, credential, transport);
  }
  async cycle() {
    await this.rpc.request('heartbeat', { runtime: 'local' });
    const pulled = (await this.rpc.request('lease', {
      runtime: 'local',
      task_type: 'ANALYZE',
    })) as { leases: { token: LeaseToken; job: JobRecord }[] };
    if (!Array.isArray(pulled.leases) || pulled.leases.length > 1)
      throw new Error('INVALID_LEASE_RESPONSE');
    const leased = pulled.leases[0];
    if (!leased) return { accepted: false, idle: true, state: null };
    if (
      leased.job.task_type !== 'ANALYZE' ||
      leased.token.job_id !== leased.job.job_id
    )
      throw new Error('INVALID_ANALYSIS_LEASE');
    await this.rpc.request('start', {
      task_type: 'ANALYZE',
      token: leased.token,
    });
    try {
      const result = await executeLocalAnalysis({
        origin: this.origin,
        credential: this.credential,
        key: this.key,
        token: leased.token,
        controlTransport: this.transport,
        providerTransport: this.providerTransport,
      });
      const completed = result.completion as {
        accepted: boolean;
        state?: string;
      } | null;
      const disposition = result.disposition as { state: string } | null;
      return {
        accepted: completed?.accepted === true,
        idle: false,
        state: completed
          ? 'SUCCEEDED'
          : (disposition?.state ?? 'DIAGNOSTIC_ONLY'),
      };
    } catch (error) {
      // Missing/stale quota never reaches provider HTTP. Durable deferral allows
      // a later fresh owner observation to resume admission without a tight loop.
      if (
        error instanceof WorkerRpcError &&
        error.route === 'analysis/reserve' &&
        error.code !== null
      ) {
        await this.rpc.request('defer', {
          task_type: 'ANALYZE',
          token: leased.token,
          reason: 'PROVIDER_UNAVAILABLE',
          due_at: new Date(Date.now() + 900000).toISOString(),
        });
        return { accepted: false, idle: false, state: 'DEFERRED' };
      }
      throw error;
    }
  }
}
