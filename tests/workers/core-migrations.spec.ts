import { env } from 'cloudflare:workers';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMigrations } from '../../packages/core/src/db/migrations.js';
import {
  AccessContext,
  ConfigRepository,
} from '../../packages/core/src/db/boundary.js';
import {
  issueSession,
  authenticateSession,
  requireCsrf,
  revokeSession,
} from '../../packages/core/src/auth/session.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import {
  authenticateWorker,
  rotateWorker,
} from '../../packages/core/src/auth/worker.js';
import { resetCore } from './core-fixture.js';

const now = new Date('2026-10-05T17:30:00Z');
const secret = 'fixture-session-signing-key-32-bytes-minimum';
describe('CP-2.1 real D1 identity boundary', () => {
  beforeEach(async () => {
    await resetCore();
  });
  it('repeat migration is idempotent; changed applied checksum blocks', async () => {
    await applyMigrations(env.DB, env.CORE_MIGRATIONS, now.toISOString());
    expect(
      await env.DB.prepare('SELECT COUNT(*) n FROM applied_migrations').first(
        'n',
      ),
    ).toBe(env.CORE_MIGRATIONS.length);
    await env.DB.prepare(
      "UPDATE applied_migrations SET sha256='corrupt'",
    ).run();
    await expect(
      applyMigrations(env.DB, env.CORE_MIGRATIONS, now.toISOString()),
    ).rejects.toThrow('APPLIED_MIGRATION_CHANGED');
  });
  it('immutable config, foreign keys and empty restore preserve canonical rows', async () => {
    await env.DB.prepare(
      "INSERT INTO config_versions VALUES('default','a',1,'{}','hash',?)",
    )
      .bind(now.toISOString())
      .run();
    await expect(
      env.DB.prepare("UPDATE config_versions SET payload_json='{}'").run(),
    ).rejects.toThrow('IMMUTABLE_CONFIG');
    await expect(
      env.DB.prepare(
        "INSERT INTO owner_sessions VALUES('bad','missing','csrf',?,?)",
      )
        .bind(now.toISOString(), '2026-10-06T00:00:00Z')
        .run(),
    ).rejects.toThrow();
    const snapshot = (
      await env.DB.prepare('SELECT * FROM owner_users ORDER BY owner_id').all<{
        owner_id: string;
        issuer: string;
        subject: string;
        allowlisted: number;
        created_at: string;
      }>()
    ).results;
    await env.DB.prepare('DELETE FROM owner_users WHERE owner_id=?')
      .bind('b')
      .run();
    const row = snapshot[1]!;
    await env.DB.prepare('INSERT INTO owner_users VALUES(?,?,?,?,?)')
      .bind(
        row.owner_id,
        row.issuer,
        row.subject,
        row.allowlisted,
        row.created_at,
      )
      .run();
    expect(
      (
        await env.DB.prepare(
          'SELECT * FROM owner_users ORDER BY owner_id',
        ).all()
      ).results,
    ).toEqual(snapshot);
    expect(
      (await env.DB.prepare('PRAGMA foreign_key_check').all()).results,
    ).toEqual([]);
    expect(
      await env.DB.prepare('PRAGMA quick_check').first('quick_check'),
    ).toBe('ok');
  });
  it('session is signed, expiring, revocable and configs cannot cross owners', async () => {
    const issued = await issueSession(
      env.DB,
      { issuer: 'https://accounts.google.com', subject: 'subject-a' },
      secret,
      now,
    );
    const cookie = issued.cookie.split(';')[0]!.split('=')[1]!;
    const context = await authenticateSession(env.DB, cookie, secret, now);
    await env.DB.prepare(
      "INSERT INTO config_versions VALUES('private','b',1,'{}','hash',?)",
    )
      .bind(now.toISOString())
      .run();
    expect(
      await new ConfigRepository(env.DB, context).get('private', 1),
    ).toBeNull();
    expect(
      () => new ConfigRepository(env.DB, { ownerId: 'b' } as AccessContext),
    ).toThrow();
    await expect(
      authenticateSession(env.DB, `${cookie}x`, secret, now),
    ).rejects.toThrow();
    await expect(
      authenticateSession(
        env.DB,
        cookie,
        secret,
        new Date('2026-10-06T02:00:00Z'),
      ),
    ).rejects.toThrow('UNAUTHENTICATED');
    const request = (origin: string, csrf?: string) =>
      new Request('https://bi.example/api/v1/sources', {
        method: 'POST',
        headers: { Origin: origin, ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      });
    await expect(
      requireCsrf(
        env.DB,
        request('https://other.example', issued.csrf),
        cookie,
        secret,
        'https://bi.example',
        now,
      ),
    ).rejects.toThrow('CSRF_DENIED');
    await expect(
      requireCsrf(
        env.DB,
        request('https://bi.example'),
        cookie,
        secret,
        'https://bi.example',
        now,
      ),
    ).rejects.toThrow('CSRF_DENIED');
    expect(
      (
        await requireCsrf(
          env.DB,
          request('https://bi.example', issued.csrf),
          cookie,
          secret,
          'https://bi.example',
          now,
        )
      ).ownerId,
    ).toBe('a');
    await revokeSession(env.DB, cookie, secret, now);
    await expect(
      authenticateSession(env.DB, cookie, secret, now),
    ).rejects.toThrow('UNAUTHENTICATED');
  });
  it('worker scope, revocation and rotation reject the old credential', async () => {
    const token = 'A'.repeat(43);
    await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
      .bind(
        'worker-a',
        'a',
        await sha256(token),
        '["FETCH_TRANSCRIPT"]',
        now.toISOString(),
      )
      .run();
    const request = (credential: string) =>
      new Request('https://bi.example/internal/workers/lease', {
        headers: { Authorization: `Bearer ${credential}` },
      });
    const worker = await authenticateWorker(
      env.DB,
      request(token),
      'FETCH_TRANSCRIPT',
    );
    expect(() => new ConfigRepository(env.DB, worker)).toThrow('FORBIDDEN');
    await expect(
      authenticateWorker(env.DB, request(token), 'BACKUP'),
    ).rejects.toThrow('FORBIDDEN');
    const session = await issueSession(
      env.DB,
      { issuer: 'https://accounts.google.com', subject: 'subject-a' },
      secret,
      now,
    );
    const owner = await authenticateSession(
      env.DB,
      session.cookie.split(';')[0]!.split('=')[1]!,
      secret,
      now,
    );
    const rotated = await rotateWorker(env.DB, owner, 'worker-a', now);
    await expect(
      authenticateWorker(env.DB, request(token), 'FETCH_TRANSCRIPT'),
    ).rejects.toThrow('UNAUTHENTICATED');
    expect(
      (await authenticateWorker(env.DB, request(rotated), 'FETCH_TRANSCRIPT'))
        .ownerId,
    ).toBe('a');
    await env.DB.prepare(
      "UPDATE worker_identities SET revoked_at=? WHERE worker_id='worker-a'",
    )
      .bind(now.toISOString())
      .run();
    await expect(
      authenticateWorker(env.DB, request(rotated), 'FETCH_TRANSCRIPT'),
    ).rejects.toThrow('UNAUTHENTICATED');
  });
});
