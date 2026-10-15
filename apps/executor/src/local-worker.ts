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
    private providerVersion: string = ytdlpProviderVersion,
    private workerId?: string,
    private representation: 'COMPACT' | 'LEGACY' = 'COMPACT',
  ) {
    this.rpc = new WorkerRpc(origin, credential, transport);
  }
  async cycle(signal?: AbortSignal) {
    signal?.throwIfAborted();
    let rpcCount = 0,
      rpcBytes = 0;
    const started = Date.now(),
      metrics: Record<string, number | string | null> = {};
    const transport: typeof fetch = (input, init) => {
      rpcCount++;
      rpcBytes +=
        typeof init?.body === 'string'
          ? new TextEncoder().encode(init.body).length
          : 0;
      return this.transport(input, {
        ...init,
        ...(signal
          ? {
              signal: AbortSignal.any([
                signal,
                ...(init?.signal ? [init.signal] : []),
              ]),
            }
          : {}),
      });
    };
    const rpc = new WorkerRpc(this.origin, this.credential, transport);
    await rpc.request('heartbeat', { runtime: 'local' });
    const admission = (await rpc.request(
      'transcript/admission',
      { runtime: 'local' },
      'GET',
    )) as {
      available: boolean;
      reason: string | null;
      next_check_at?: string | null;
    };
    if (!admission.available)
      return {
        accepted: false,
        reason: admission.reason,
        idle: false,
        retry_after_ms: Math.max(
          30000,
          Date.parse(admission.next_check_at ?? '') - Date.now() || 0,
        ),
      };
    const pulled = (await rpc.request('lease', {
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
    if (this.workerId && token.lease_owner !== this.workerId)
      throw new Error('EXECUTOR_AUTH_DENIED');
    const task = leased.job.task_type;
    await rpc.request('start', { task_type: task, token });
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
    let cooldown = 0;
    const heartbeat = async () => {
      const result = (await rpc.request('heartbeat', {
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
      transport,
    );
    try {
      const item = (await rpc.request('transcript/input', {
        token,
      })) as SourceItemRef;
      metrics.detected_at = item.detected_at ?? null;
      metrics.fetch_started_at = new Date().toISOString();
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
            provider_version: this.providerVersion,
            request_id: crypto.randomUUID(),
            ...(signal ? { signal } : {}),
          },
          this.provider,
          artifacts,
          {
            admission: async () => {
              const admitted = (await rpc.request(
                'transcript/admission',
                { runtime: 'local' },
                'GET',
              )) as {
                available: boolean;
                reason: string | null;
                next_check_at: string | null;
              };
              if (!admitted.available) {
                await rpc.request('defer', {
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
            measure: (value) => Object.assign(metrics, value),
            outcome: async (status, retryAfter) => {
              const decision = (await rpc.request('transcript/outcome', {
                token,
                status,
                ...(retryAfter ? { retry_after: retryAfter } : {}),
              })) as { due_at?: string };
              if (
                [
                  'IP_BLOCKED',
                  'RATE_LIMITED',
                  'PARSE_ERROR',
                  'UPSTREAM_CHANGED',
                  'TEMPORARY_FAILURE',
                ].includes(status)
              )
                cooldown = Math.max(
                  30000,
                  Date.parse(decision.due_at ?? '') - Date.now() || 0,
                );
              completed = true;
            },
            diagnostic: async (code) => {
              if (code === 'STALE_TRANSCRIPT_LEASE') return;
              await rpc.request('defer', {
                token,
                task_type: task,
                reason: 'PROVIDER_UNAVAILABLE',
                due_at: new Date(Date.now() + 21600000).toISOString(),
              });
              completed = true;
            },
            accept: async (source) => {
              const result = (await rpc.request('transcript/accept', {
                token,
                source,
              })) as { accepted: boolean };
              if (result.accepted !== true)
                throw new Error('SOURCE_ACCEPTANCE_REJECTED');
              completed = true;
            },
          },
          60000,
          null,
          this.representation,
        )),
        idle: false,
        ...(cooldown > 0 ? { retry_after_ms: cooldown } : {}),
        metrics: {
          ...metrics,
          rpc_count: rpcCount,
          rpc_request_bytes: rpcBytes,
          worker_cycle_ms: Date.now() - started,
        },
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
