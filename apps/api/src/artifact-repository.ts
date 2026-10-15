import type { Env } from './env.js';
import { AccessContext } from '../../../packages/core/src/db/boundary.js';
import { ArtifactRepository } from '../../../packages/core/src/artifacts/store.js';
import { TranscriptPayloadArchive } from '../../../packages/core/src/transcript/payload-archive.js';
import { dailyDriveClient } from './daily-workflow.js';
import { sha256 } from '../../../packages/core/src/auth/crypto.js';
/** Keep Drive credentials on Cloudflare. Existing item/lease authorization runs
 * before the resolver; the exporter credential must resolve to the same owner. */
export function artifactRepository(
  environment: Env,
  access: AccessContext,
  reservation: string | null = null,
) {
  return new ArtifactRepository(
    environment.DB,
    access,
    reservation,
    async (header) => {
      const exporter =
        access.kind === 'owner'
          ? access
          : await AccessContext.worker(
              environment.DB,
              await sha256(environment.DRIVE_EXPORT_WORKER_CREDENTIAL ?? ''),
            );
      if (exporter.ownerId !== access.ownerId) throw new Error('FORBIDDEN');
      exporter.requireOwnerOrTask('DRIVE_EXPORT');
      return new TranscriptPayloadArchive(environment.DB, exporter).read(
        header,
        (id) => dailyDriveClient(environment, exporter, id, new Date()),
      );
    },
  );
}
