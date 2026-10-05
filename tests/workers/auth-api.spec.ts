import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { it, expect, beforeEach } from 'vitest';
import worker from '../../apps/api/src/index.js';
import { resetCore } from './core-fixture.js';
import {
  authCallbackPath,
  oidcConfiguration,
} from '../../apps/api/src/auth.js';
import application from '../../config/application.json';
beforeEach(resetCore);
it('configured callback exactly matches the real API route and missing secrets fail closed', async () => {
  expect(authCallbackPath).toBe('/api/v1/auth/callback');
  const response = await worker.fetch(
    new Request(application.app_origin + authCallbackPath),
    env,
    createExecutionContext(),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: 'AUTH_CONFIGURATION_REQUIRED',
  });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});
it('client callback is derived from the authoritative configured origin and cannot be forged through Host', async () => {
  const settings = {
    ...env,
    GOOGLE_OIDC_CLIENT_ID: 'fixture-client',
    GOOGLE_OIDC_CLIENT_SECRET: 'fixture-only',
    GOOGLE_OIDC_OWNER_SUBJECT: 'subject-a',
    SESSION_SIGNING_SECRET: 'fixture-session-secret-32-characters-minimum',
  };
  expect(oidcConfiguration(settings).redirectUri).toBe(
    application.app_origin + '/api/v1/auth/callback',
  );
  expect(() =>
    oidcConfiguration({ ...settings, APP_ORIGIN: 'https://evil.example' }),
  ).toThrow('AUTH_CONFIGURATION_REQUIRED');
  const response = await worker.fetch(
    new Request(application.app_origin + '/api/v1/auth/login'),
    settings,
    createExecutionContext(),
  );
  expect(response.status).toBe(302);
  const target = new URL(response.headers.get('Location')!);
  expect(target.searchParams.get('redirect_uri')).toBe(
    application.app_origin + '/api/v1/auth/callback',
  );
  expect(target.searchParams.get('scope')).toBe('openid');
  expect(target.searchParams.get('client_id')).toBe('fixture-client');
});
