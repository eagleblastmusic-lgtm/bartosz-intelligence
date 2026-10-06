import { WorkerRpc } from './worker-rpc.js';
import { ArtifactClient } from './artifact-client.js';
import type {
  LeaseToken,
  JobRecord,
} from '../../../packages/contracts/src/jobs.js';
import type { SourceCorrectionSnapshot } from '../../../packages/core/src/transcript/correction-jobs.js';
import type { normalizeTranscript } from '../../../packages/core/src/transcript/normalize.js';
import { materializeCorrectedSource } from '../../../packages/core/src/transcript/corrected-source.js';
import { sha256 } from '../../../packages/core/src/auth/crypto.js';
export class LocalSourceCorrectionWorker {
  private rpc: WorkerRpc;
  constructor(
    private origin: string,
    private credential: string,
    private transport: typeof fetch = fetch,
  ) {
    this.rpc = new WorkerRpc(origin, credential, transport);
  }
  async cycle() {
    await this.rpc.request('heartbeat', { runtime: 'local' });
    const pulled = (await this.rpc.request('lease', {
      runtime: 'local',
      task_type: 'NORMALIZE',
    })) as { leases: { token: LeaseToken; job: JobRecord }[] };
    if (!Array.isArray(pulled.leases) || pulled.leases.length > 1)
      throw new Error('INVALID_LEASE_RESPONSE');
    const leased = pulled.leases[0];
    if (!leased) return { accepted: false, idle: true };
    let token = leased.token;
    if (
      leased.job.task_type !== 'NORMALIZE' ||
      token.job_id !== leased.job.job_id
    )
      throw new Error('INVALID_CORRECTION_LEASE');
    await this.rpc.request('start', { task_type: 'NORMALIZE', token });
    const heartbeat = async () => {
      const result = (await this.rpc.request('heartbeat', {
        runtime: 'local',
        task_type: 'NORMALIZE',
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
    try {
      const { snapshot } = (await this.rpc.request('source-correction/input', {
        token,
      })) as { snapshot: SourceCorrectionSnapshot };
      const artifacts = new ArtifactClient(
        this.origin,
        this.credential,
        () => token,
        'NORMALIZE',
        this.transport,
      );
      const { text: original } = await artifacts.readText(
        snapshot.original_ref,
      );
      await heartbeat();
      const { text: manifestText } = await artifacts.readText(
        snapshot.segment_map_artifact_id,
      );
      if (
        (await sha256(original)) !== snapshot.original_hash ||
        (await sha256(manifestText)) !== snapshot.manifest_hash
      )
        throw new Error('SOURCE_CORRECTION_SNAPSHOT_INVALID');
      const manifest = JSON.parse(manifestText) as Awaited<
        ReturnType<typeof normalizeTranscript>
      >['manifest'];
      if (
        manifest.source_text_hash !== snapshot.original_hash ||
        manifest.normalizer_version !== 'source-normalizer:1' ||
        manifest.offset_unit !== 'UTF16_CODE_UNIT' ||
        manifest.join_separator !== '\n' ||
        !manifest.complete ||
        !Array.isArray(manifest.coverage) ||
        !Array.isArray(manifest.anchors)
      )
        throw new Error('SOURCE_CORRECTION_MANIFEST_INVALID');
      let offset = 0;
      const cues = manifest.coverage.map((cue) => {
        if (
          cue.raw_start !== offset ||
          !Number.isSafeInteger(cue.raw_end) ||
          cue.raw_end < cue.raw_start ||
          cue.raw_end > original.length
        )
          throw new Error('SOURCE_CORRECTION_MANIFEST_INVALID');
        offset = cue.raw_end + 1;
        return {
          upstream_index: cue.upstream_index,
          start_ms: cue.start_ms,
          end_ms: cue.end_ms,
          text: original.slice(cue.raw_start, cue.raw_end),
          speaker_label: null,
        };
      });
      if (
        offset !== original.length + 1 ||
        cues.map((cue) => cue.text).join('\n') !== original
      )
        throw new Error('SOURCE_CORRECTION_MANIFEST_INVALID');
      const precisions = [
        ...new Set(
          manifest.anchors.map((anchor) => anchor.timestamp_precision),
        ),
      ];
      if (precisions.length !== 1)
        throw new Error('SOURCE_CORRECTION_PRECISION_INVALID');
      const corrected = await materializeCorrectedSource({
        ...snapshot,
        cues,
        precision: precisions[0]!,
      });
      await heartbeat();
      const common = {
        item_id: snapshot.item_id,
        schema_version: 'corrected-source:1',
        producer_version: 'owner-source-correction:1',
        original_ref: snapshot.original_ref,
        provenance: {
          kind: 'CORRECTED_SOURCE',
          correction_job_id: token.job_id,
          original_hash: snapshot.original_hash,
          authored_by: snapshot.authored_by,
          reason: snapshot.reason,
        },
      };
      const source = await artifacts.upload(corrected.normalized.source_text, {
        ...common,
        kind: 'NORMALIZED',
      });
      await heartbeat();
      const map = await artifacts.upload(
        JSON.stringify(corrected.normalized.manifest),
        { ...common, kind: 'SEGMENT_MAP' },
      );
      await heartbeat();
      const result = (await this.rpc.request('source-correction/complete', {
        token,
        source_artifact_id: source.artifact_id,
        segment_map_artifact_id: map.artifact_id,
      })) as { accepted: boolean };
      return { ...result, idle: false };
    } catch (error) {
      if (
        error instanceof Error &&
        /^(INVALID_SOURCE_CORRECTION|SOURCE_CORRECTION_)/.test(error.message)
      ) {
        await this.rpc.request('retry', {
          task_type: 'NORMALIZE',
          token,
          code: 'INVALID_INPUT',
        });
        return { accepted: false, idle: false, state: 'BLOCKED' };
      }
      throw error;
    }
  }
}
