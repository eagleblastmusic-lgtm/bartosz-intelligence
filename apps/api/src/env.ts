export interface Env {
  DB: D1Database;
  BARTOSZ_QUEUE: Queue;
  ASSETS: Fetcher;
  APP_ORIGIN?: string;
  GOOGLE_OIDC_CLIENT_ID?: string;
  GOOGLE_OIDC_CLIENT_SECRET?: string;
  GOOGLE_OIDC_OWNER_SUBJECT?: string;
  SESSION_SIGNING_SECRET?: string;
  YOUTUBE_API_KEY?: string;
  CONTROL_WORKER_CREDENTIAL?: string;
  LOCAL_WORKER_CREDENTIAL?: string;
}
