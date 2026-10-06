import type {
  JobRecord,
  LeaseToken,
} from '../../../packages/contracts/src/jobs.js';
import { WorkerRpc, WorkerRpcError } from './worker-rpc.js';
import { executeLocalAnalysis } from './analysis-transport.js';
import {
  prepareLongAnalysis,
  resumeChunkPreparation,
} from './analysis-chunks.js';

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
      if (error instanceof Error && error.message === 'CHUNKS_WAITING') {
        const merged = (await this.rpc.request('analysis/chunks/complete', {
          token: leased.token,
        })) as {
          accepted: boolean;
          state: string;
          preparation_required?: boolean;
          plan_artifact_id?: string;
          plan_hash?: string;
        };
        if (merged.preparation_required) {
          if (!merged.plan_artifact_id || !merged.plan_hash)
            throw new Error('CHUNK_PLAN_MISMATCH');
          return resumeChunkPreparation(
            this.rpc,
            leased.token,
            merged.plan_artifact_id,
            merged.plan_hash,
          );
        }
        return { accepted: merged.accepted, idle: false, state: merged.state };
      }
      if (error instanceof Error && error.message === 'LONG_INPUT_REQUIRED')
        return prepareLongAnalysis({
          origin: this.origin,
          credential: this.credential,
          token: leased.token,
          transport: this.transport,
        });
      // Admission failures happen before provider HTTP. Preserve the pinned
      // snapshot and defer; expiry never selects a newer model implicitly.
      if (
        error instanceof WorkerRpcError &&
        [
          'analysis/input',
          'analysis/context',
          'analysis/reserve',
          'analysis/submit',
        ].includes(error.route) &&
        (error.code === 'ANALYSIS_PROFILE_ACCOUNT_PURPOSE_REGION' ||
          error.code === 'ANALYSIS_PROFILE_QUALITY_SCOPE' ||
          (error.route === 'analysis/reserve' &&
            (error.code === 'QUOTA_UNKNOWN_OR_STALE' ||
              error.code === 'QUOTA_ADMISSION_DENIED')))
      ) {
        await this.rpc.request('defer', {
          task_type: 'ANALYZE',
          token: leased.token,
          reason: error.code?.startsWith('ANALYSIS_PROFILE_')
            ? 'MODEL_NOT_ELIGIBLE'
            : 'PROVIDER_UNAVAILABLE',
          due_at: new Date(Date.now() + 900000).toISOString(),
        });
        return { accepted: false, idle: false, state: 'DEFERRED' };
      }
      throw error;
    }
  }
}
