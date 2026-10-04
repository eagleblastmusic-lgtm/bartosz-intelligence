import type { Env as WorkerEnv } from '../../apps/api/src/index.js';
declare global {
  namespace Cloudflare {
    // The installed Workers types use Cloudflare.Env for binding augmentation.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends WorkerEnv {}
  }
}
