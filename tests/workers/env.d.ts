import type { Env as WorkerEnv } from '../../apps/api/src/index.js';
declare global {
  namespace Cloudflare {
    // The installed Workers types use Cloudflare.Env for binding augmentation.
    interface Env extends WorkerEnv {
      CORE_MIGRATIONS: import('../../packages/core/src/db/migrations.js').RuntimeMigration[];
    }
  }
}
