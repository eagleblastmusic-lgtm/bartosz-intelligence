import { env } from 'cloudflare:workers';
import { applyMigrations } from '../../packages/core/src/db/migrations.js';
import {
  issueSession,
  authenticateSession,
} from '../../packages/core/src/auth/session.js';
export const fixtureNow = new Date('2026-10-05T17:30:00.000Z');
export const fixtureSecret = 'fixture-session-signing-key-32-bytes-minimum';
export async function resetCore() {
  const views = (
    await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='view'",
    ).all<{ name: string }>()
  ).results;
  const tables = (
    await env.DB.prepare('PRAGMA table_list').all<{
      name: string;
      type: string;
    }>()
  ).results.filter(
    (row) =>
      ['table', 'virtual'].includes(row.type) &&
      !row.name.startsWith('sqlite_') &&
      !row.name.startsWith('_cf_'),
  );
  await env.DB.batch([
    env.DB.prepare('PRAGMA defer_foreign_keys=ON'),
    ...views.map((row) =>
      env.DB.prepare(`DROP VIEW "${row.name.replaceAll('"', '""')}"`),
    ),
    ...tables.map((row) =>
      env.DB.prepare(`DROP TABLE "${row.name.replaceAll('"', '""')}"`),
    ),
  ]);
  await applyMigrations(env.DB, env.CORE_MIGRATIONS, fixtureNow.toISOString());
  await env.DB.batch(
    ['a', 'b'].map((owner) =>
      env.DB.prepare('INSERT INTO owner_users VALUES(?,?,?,?,?)').bind(
        owner,
        'https://accounts.google.com',
        `subject-${owner}`,
        1,
        fixtureNow.toISOString(),
      ),
    ),
  );
}
export async function fixtureOwner(owner = 'a') {
  const session = await issueSession(
    env.DB,
    { issuer: 'https://accounts.google.com', subject: `subject-${owner}` },
    fixtureSecret,
    fixtureNow,
  );
  return authenticateSession(
    env.DB,
    session.cookie.split(';')[0]!.split('=')[1]!,
    fixtureSecret,
    fixtureNow,
  );
}
