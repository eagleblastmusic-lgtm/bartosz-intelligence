import type {
  JobRecord,
  LeaseToken,
} from '../../../packages/contracts/src/jobs.js';
import type {
  SourceItemRef,
  TranscriptProvider,
} from '../../../packages/contracts/src/transcript.js';
import { WorkerRpc } from './worker-rpc.js';
import { ArtifactClient } from './artifact-client.js';
import { executeTranscript } from './transcript-runner.js';
import {
  ytdlpProviderVersion,
  YtdlpTranscriptProvider,
} from './providers/ytdlp.js';

export class LocalTranscriptWorker {
  private rpc: WorkerRpc;
  constructor(
    private origin: string,
    private credential: string,
    private provider: TranscriptProvider = new YtdlpTranscriptProvider(),
    private transport: typeof fetch = fetch,
  ) {
    this.rpc = new WorkerRpc(origin, credential, transport);
  }
  async cycle() {
    await this.rpc.request('heartbeat', { runtime: 'local' });
    const admission = (await this.rpc.request(
      'transcript/admission',
      { runtime: 'local' },
      'GET',
    )) as { available: boolean; reason: string | null };
    if (!admission.available)
      return { accepted: false, reason: admission.reason, idle: true };
    const pulled = (await this.rpc.request('lease', {
      runtime: 'local',
      task_type: 'FETCH_TRANSCRIPT',
    })) as {
      leases: { token: LeaseToken; job: JobRecord }[];
    };
    if (!Array.isArray(pulled.leases) || pulled.leases.length > 1)
      throw new Error('INVALID_LEASE_RESPONSE');
    const leased = pulled.leases[0];
    if (!leased) return { accepted: false, reason: null, idle: true };
    let token = leased.token;
    const task = leased.job.task_type;
    await this.rpc.request('start', { task_type: task, token });
    // This worker's credential must expose only implemented task capabilities.
    if (task !== 'FETCH_TRANSCRIPT') {
      await this.rpc.request('retry', {
        task_type: task,
        token,
        code: 'INVALID_INPUT',
      });
      throw new Error('UNSUPPORTED_LOCAL_TASK');
    }
    let completed = false;
    const heartbeat = async () => {
      const result = (await this.rpc.request('heartbeat', {
        runtime: 'local',
        task_type: task,
        token,
      })) as { token: LeaseToken | null };
      if (
        !result.token ||
        result.token.job_id !== token.job_id ||
        result.token.fencing_token !== token.fencing_token ||
        result.token.lease_owner !== token.lease_owner
      )
        throw new Error('STALE_FENCE');
      token = result.token;
    };
    const artifacts = new ArtifactClient(
      this.origin,
      this.credential,
      () => token,
      task,
      this.transport,
    );
    try {
      const item = (await this.rpc.request('transcript/input', {
        token,
      })) as SourceItemRef;
      return {
        ...(await executeTranscript(
          item,
          {
            job_id: token.job_id,
            item_id: item.item_id,
            runtime_id: 'local',
            deadline: new Date(Date.now() + 180000).toISOString(),
            max_bytes: 4 * 1024 * 1024,
            quota_reservation_id: null,
            provider_version: ytdlpProviderVersion,
            request_id: crypto.randomUUID(),
          },
          this.provider,
          artifacts,
          {
            admission: async () => {
              const admitted = (await this.rpc.request(
                'transcript/admission',
                { runtime: 'local' },
                'GET',
              )) as {
                available: boolean;
                reason: string | null;
                next_check_at: string | null;
              };
              if (!admitted.available) {
                await this.rpc.request('defer', {
                  token,
                  task_type: task,
                  reason: 'PROVIDER_UNAVAILABLE',
                  due_at:
                    admitted.next_check_at ??
                    new Date(Date.now() + 1800000).toISOString(),
                });
                completed = true;
              }
              return admitted;
            },
            heartbeat,
            outcome: async (status) => {
              await this.rpc.request('transcript/outcome', { token, status });
              completed = true;
            },
            diagnostic: async (code) => {
              if (code === 'STALE_TRANSCRIPT_LEASE') return;
              await this.rpc.request('defer', {
                token,
                task_type: task,
                reason: 'PROVIDER_UNAVAILABLE',
                due_at: new Date(Date.now() + 21600000).toISOString(),
              });
              completed = true;
            },
            accept: async (source) => {
              const result = (await this.rpc.request('transcript/accept', {
                token,
                source,
              })) as { accepted: boolean };
              if (result.accepted !== true)
                throw new Error('SOURCE_ACCEPTANCE_REJECTED');
              completed = true;
            },
          },
        )),
        idle: false,
      };
    } catch (error) {
      if (!completed) {
        // A transport failure leaves a durable lease. If the server is reachable,
        // release it into the existing bounded retry policy; otherwise sweeper recovers it.
        try {
          await this.rpc.request('retry', {
            token,
            task_type: task,
            code: 'TRANSIENT',
          });
        } catch {
          /* No accepted effects; durable lease expiry is authoritative. */
        }
      }
      throw error;
    }
  }
}
