import { env } from 'cloudflare:workers';
import { beforeEach, it, expect } from 'vitest';
import { resetCore, fixtureNow } from './core-fixture.js';
import { randomToken, sha256 } from '../../packages/core/src/auth/crypto.js';
import {
  beginOwnerBootstrap,
  bootstrapState,
  claimBootstrapOwner,
} from '../../packages/core/src/auth/bootstrap.js';
import { runtimeOidcConfiguration } from '../../apps/api/src/auth.js';
const config = {
  clientId: 'fixture-client',
  clientSecret: 'fixture-only',
  redirectUri: 'https://bi.example/api/v1/auth/callback',
  ownerSubject: '',
};
beforeEach(async () => {
  await resetCore();
  await env.DB.prepare('DELETE FROM owner_users').run();
});
async function grant() {
  const value = randomToken();
  await env.DB.prepare(
    'INSERT INTO owner_bootstrap_grants(grant_hash,expires_at) VALUES(?,?)',
  )
    .bind(
      await sha256(value),
      new Date(fixtureNow.getTime() + 3600000).toISOString(),
    )
    .run();
  return value;
}
it('public first login cannot establish owner and wrong, expired or reused capabilities fail closed', async () => {
  await expect(
    beginOwnerBootstrap(env.DB, config, randomToken(), fixtureNow),
  ).rejects.toThrow('FORBIDDEN');
  const capability = await grant();
  await expect(
    beginOwnerBootstrap(
      env.DB,
      config,
      capability,
      new Date(fixtureNow.getTime() + 3600001),
    ),
  ).rejects.toThrow('FORBIDDEN');
  const intent = await beginOwnerBootstrap(
      env.DB,
      config,
      capability,
      fixtureNow,
    ),
    state = new URL(intent.url).searchParams.get('state')!;
  await expect(
    beginOwnerBootstrap(env.DB, config, capability, fixtureNow),
  ).rejects.toThrow('FORBIDDEN');
  expect(await bootstrapState(env.DB, state, fixtureNow)).toBe(true);
  await expect(
    claimBootstrapOwner(
      env.DB,
      state,
      { issuer: 'https://accounts.google.com', subject: 'owner-subject' },
      fixtureNow,
    ),
  ).rejects.toThrow('FORBIDDEN');
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS n FROM owner_users').first('n'),
  ).toBe(0);
});
it('two validated bootstrap intents can pin only one owner and close enrollment permanently', async () => {
  const intents = await Promise.all([grant(), grant()]);
  const states = [];
  for (const capability of intents) {
    const intent = await beginOwnerBootstrap(
      env.DB,
      config,
      capability,
      fixtureNow,
    );
    states.push(new URL(intent.url).searchParams.get('state')!);
  }
  for (const state of states)
    await env.DB.prepare(
      'UPDATE oidc_login_intents SET consumed_at=? WHERE state_hash=?',
    )
      .bind(fixtureNow.toISOString(), await sha256(state))
      .run();
  const claims = await Promise.allSettled(
    states.map((state, index) =>
      claimBootstrapOwner(
        env.DB,
        state,
        { issuer: 'https://accounts.google.com', subject: `owner-${index}` },
        fixtureNow,
      ),
    ),
  );
  expect(claims.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
  expect(
    await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM owner_users WHERE allowlisted=1',
    ).first('n'),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM owner_bootstrap_grants WHERE consumed_at IS NOT NULL',
    ).first('n'),
  ).toBe(1);
  await expect(
    beginOwnerBootstrap(env.DB, config, await grant(), fixtureNow),
  ).rejects.toThrow('FORBIDDEN');
  const settings = {
    ...env,
    GOOGLE_OIDC_CLIENT_ID: config.clientId,
    GOOGLE_OIDC_CLIENT_SECRET: config.clientSecret,
    SESSION_SIGNING_SECRET: 'fixture-secret-at-least-32-characters',
  };
  expect((await runtimeOidcConfiguration(settings)).ownerSubject).toMatch(
    /^owner-[01]$/,
  );
});
