import type {
  JobRecord,
  LeaseToken,
} from '../../../packages/contracts/src/jobs.js';
import type { AIRequest } from '../../../packages/contracts/src/ai.js';
import type { OptionalTask } from '../../../packages/core/src/ai/tasks/jobs.js';
import { WorkerRpc, WorkerRpcError } from './worker-rpc.js';
import { executePreparedAnalysis } from './analysis-transport.js';
import { retainAnalysisResponse } from './analysis-response.js';

export class LocalOptionalAIWorker {
  private rpc: WorkerRpc;
  constructor(
    private task: OptionalTask,
    private origin: string,
    private credential: string,
    private key: string,
    private transport: typeof fetch = fetch,
    private providerTransport: typeof fetch = fetch,
  ) {
    if (!key || !['TRANSLATE', 'HISTORICAL_COMPARE'].includes(task))
      throw new Error('AI_EXECUTOR_CONFIGURATION_REQUIRED');
    this.rpc = new WorkerRpc(origin, credential, transport);
  }
  async cycle() {
    await this.rpc.request('heartbeat', { runtime: 'local' });
    const pulled = (await this.rpc.request('lease', {
      runtime: 'local',
      task_type: this.task,
    })) as { leases: { job: JobRecord; token: LeaseToken }[] };
    if (!Array.isArray(pulled.leases) || pulled.leases.length > 1)
      throw new Error('INVALID_LEASE_RESPONSE');
    const leased = pulled.leases[0];
    if (!leased) return { accepted: false, idle: true, state: null };
    if (
      leased.job.task_type !== this.task ||
      leased.job.job_id !== leased.token.job_id
    )
      throw new Error('INVALID_OPTIONAL_LEASE');
    await this.rpc.request('start', {
      task_type: this.task,
      token: leased.token,
    });
    try {
      const prepared = (await this.rpc.request('optional/input', {
        task_type: this.task,
        token: leased.token,
      })) as { request: AIRequest; snapshot: { item_id: string } };
      const result = await executePreparedAnalysis({
        request: prepared.request,
        task_type: this.task,
        token: leased.token,
        key: this.key,
        rpc: this.rpc,
        providerTransport: this.providerTransport,
        retain: (reservation_id, token, response) =>
          retainAnalysisResponse({
            origin: this.origin,
            credential: this.credential,
            task_type: this.task,
            token,
            reservation_id,
            item_id: prepared.snapshot.item_id,
            response,
            transport: this.transport,
          }),
      });
      if (!result.eligible_for_validation) {
        if (result.diagnostics.length)
          return { accepted: false, idle: false, state: 'DIAGNOSTIC_ONLY' };
        const status = result.response.status;
        const disposition =
          status === 'RATE_LIMITED'
            ? await this.rpc.request('defer', {
                task_type: this.task,
                token: result.token,
                reason: 'PROVIDER_UNAVAILABLE',
                due_at: new Date(
                  Math.min(
                    Date.now() + 86340000,
                    Math.max(
                      Date.now() + 900000,
                      Date.parse(result.response.retry_after ?? '') || 0,
                    ),
                  ),
                ).toISOString(),
              })
            : await this.rpc.request('retry', {
                task_type: this.task,
                token: result.token,
                code:
                  status === 'AUTH_REQUIRED'
                    ? 'AUTH'
                    : status === 'REFUSED' || status === 'INVALID_REQUEST'
                      ? 'INVALID_INPUT'
                      : 'TRANSIENT',
              });
        return {
          accepted: false,
          idle: false,
          state: (disposition as { state: string }).state,
        };
      }
      const completion = (await this.rpc.request('optional/complete', {
        task_type: this.task,
        token: result.token,
        reservation_id: result.reservation_id,
        artifact_id: result.response_artifact_id,
      })) as { accepted: boolean; state?: string };
      return {
        accepted: completion.accepted,
        idle: false,
        state: completion.state ?? 'SUCCEEDED',
      };
    } catch (error) {
      if (
        error instanceof WorkerRpcError &&
        error.status === 503 &&
        (error.code?.startsWith('OPTIONAL_PROFILE_') ||
          error.code?.startsWith('QUOTA_'))
      ) {
        await this.rpc.request('defer', {
          task_type: this.task,
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
