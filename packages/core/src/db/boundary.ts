export interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<{ meta: { changes: number } }[]>;
}

const contexts = new WeakSet<object>();
export class AccessContext {
  private constructor(
    readonly ownerId: string,
    readonly actorId: string,
    readonly kind: 'owner' | 'worker',
    readonly scopes: readonly string[],
  ) {
    contexts.add(this);
    Object.freeze(this);
  }
  static async owner(db: Database, sessionHash: string, now: string) {
    const row = await db
      .prepare(
        `SELECT s.owner_id FROM owner_sessions s JOIN owner_users u USING(owner_id)
       WHERE s.session_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.allowlisted=1`,
      )
      .bind(sessionHash, now)
      .first<{ owner_id: string }>();
    if (!row) throw new Error('UNAUTHENTICATED');
    return new AccessContext(row.owner_id, row.owner_id, 'owner', []);
  }
  static async worker(db: Database, credentialHash: string) {
    const row = await db
      .prepare(
        `SELECT w.owner_id,w.worker_id,w.scopes_json FROM worker_identities w
       JOIN owner_users u USING(owner_id)
       WHERE w.credential_hash=? AND w.revoked_at IS NULL AND u.allowlisted=1`,
      )
      .bind(credentialHash)
      .first<{ owner_id: string; worker_id: string; scopes_json: string }>();
    if (!row) throw new Error('UNAUTHENTICATED');
    const scopes: unknown = JSON.parse(row.scopes_json);
    if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string'))
      throw new Error('INVALID_WORKER_SCOPE');
    return new AccessContext(
      row.owner_id,
      row.worker_id,
      'worker',
      Object.freeze(scopes),
    );
  }
  requireOwner() {
    assertContext(this);
    if (this.kind !== 'owner') throw new Error('FORBIDDEN');
  }
  requireTask(task: string) {
    assertContext(this);
    if (this.kind !== 'worker' || !this.scopes.includes(task))
      throw new Error('FORBIDDEN');
  }
}
export function assertContext(context: AccessContext) {
  if (!contexts.has(context)) throw new Error('INVALID_ACCESS_CONTEXT');
}

export class ConfigRepository {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    context.requireOwner();
  }
  async get(configId: string, revision: number) {
    return this.db
      .prepare(
        'SELECT config_id,revision,payload_json,content_hash FROM config_versions WHERE owner_id=? AND config_id=? AND revision=?',
      )
      .bind(this.context.ownerId, configId, revision)
      .first();
  }
}
