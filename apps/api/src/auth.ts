import { Hono } from 'hono';
import type { Env } from './env.js';
import application from '../../../config/application.json';
import {
  beginLogin,
  finishLogin,
  OidcFailure,
} from '../../../packages/core/src/auth/oidc.js';
import {
  issueSession,
  authenticateSession,
  requireCsrf,
  revokeSession,
} from '../../../packages/core/src/auth/session.js';
import { sha256 } from '../../../packages/core/src/auth/crypto.js';
import {
  beginOwnerBootstrap,
  bootstrapState,
  claimBootstrapOwner,
} from '../../../packages/core/src/auth/bootstrap.js';
export const authCallbackPath = application.auth_callback_path;
export const authApp = new Hono<{ Bindings: Env }>();
export function applicationOrigin(env: Env) {
  const origin = env.APP_ORIGIN ?? application.app_origin;
  if (
    origin !== application.app_origin ||
    new URL(origin).origin !== origin ||
    !origin.startsWith('https://')
  )
    throw new Error('AUTH_CONFIGURATION_REQUIRED');
  return origin;
}
export function oidcConfiguration(env: Env) {
  if (
    !env.GOOGLE_OIDC_CLIENT_ID ||
    !env.GOOGLE_OIDC_CLIENT_SECRET ||
    !env.GOOGLE_OIDC_OWNER_SUBJECT ||
    !env.SESSION_SIGNING_SECRET ||
    env.SESSION_SIGNING_SECRET.length < 32
  )
    throw new Error('AUTH_CONFIGURATION_REQUIRED');
  return {
    clientId: env.GOOGLE_OIDC_CLIENT_ID,
    clientSecret: env.GOOGLE_OIDC_CLIENT_SECRET,
    ownerSubject: env.GOOGLE_OIDC_OWNER_SUBJECT,
    redirectUri: applicationOrigin(env) + authCallbackPath,
  };
}
export function cookieValue(request: Request, name: string) {
  const pairs = (request.headers.get('Cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name + '='));
  if (pairs.length > 1) throw new Error('UNAUTHENTICATED');
  return pairs[0]?.slice(name.length + 1) ?? '';
}
export async function runtimeOidcConfiguration(env: Env) {
  if (env.GOOGLE_OIDC_OWNER_SUBJECT) return oidcConfiguration(env);
  const owners = (
    await env.DB.prepare(
      'SELECT subject FROM owner_users WHERE allowlisted=1 LIMIT 2',
    ).all<{ subject: string }>()
  ).results;
  if (owners.length !== 1) throw new Error('AUTH_CONFIGURATION_REQUIRED');
  return oidcConfiguration({
    ...env,
    GOOGLE_OIDC_OWNER_SUBJECT: owners[0]!.subject,
  });
}
export async function ownerContext(
  env: Env,
  request: Request,
  mutation = false,
) {
  await runtimeOidcConfiguration(env);
  const signed = cookieValue(request, '__Host-bi-session');
  return mutation
    ? requireCsrf(
        env.DB,
        request,
        signed,
        env.SESSION_SIGNING_SECRET!,
        applicationOrigin(env),
        new Date(),
      )
    : authenticateSession(
        env.DB,
        signed,
        env.SESSION_SIGNING_SECRET!,
        new Date(),
      );
}
authApp.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
authApp.onError((error, c) => {
  const config = error.message === 'AUTH_CONFIGURATION_REQUIRED';
  const forbidden = ['CSRF_DENIED', 'FORBIDDEN'].includes(error.message);
  return c.json(
    {
      code: config
        ? 'AUTH_CONFIGURATION_REQUIRED'
        : forbidden
          ? 'FORBIDDEN'
          : 'UNAUTHENTICATED',
      message: config
        ? 'Owner authentication configuration is required.'
        : 'Authentication denied.',
      correlation_id: crypto.randomUUID(),
      ...(error instanceof OidcFailure ? { reason: error.reason } : {}),
    },
    config ? 503 : forbidden ? 403 : 401,
  );
});
authApp.get('/login', async (c) => {
  const returnPath =
    c.req.query('return_to') === '/system/connections'
      ? '/system/connections'
      : '/';
  const intent = await beginLogin(
    c.env.DB,
    await runtimeOidcConfiguration(c.env),
    new Date(),
  );
  c.header('Set-Cookie', intent.browserCookie);
  c.header(
    'Set-Cookie',
    `__Host-bi-return=${encodeURIComponent(returnPath)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    { append: true },
  );
  return c.redirect(intent.url, 302);
});
authApp.post('/bootstrap/login', async (c) => {
  if (Number(c.req.header('Content-Length') ?? 0) > 256)
    throw new Error('FORBIDDEN');
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new Error('FORBIDDEN');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 256) {
      await reader.cancel();
      throw new Error('FORBIDDEN');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value = new TextDecoder().decode(bytes);
  const capability = new URLSearchParams(value).get('capability') ?? '';
  const config = oidcConfiguration({
    ...c.env,
    GOOGLE_OIDC_OWNER_SUBJECT: 'bootstrap-only',
  });
  const intent = await beginOwnerBootstrap(
    c.env.DB,
    config,
    capability,
    new Date(),
  );
  c.header('Set-Cookie', intent.browserCookie);
  c.header('Referrer-Policy', 'no-referrer');
  return c.redirect(intent.url, 303);
});
authApp.get('/callback', async (c) => {
  const state = c.req.query('state') ?? '',
    now = new Date();
  const bootstrap = await bootstrapState(c.env.DB, state, now);
  const config = bootstrap
    ? {
        ...oidcConfiguration({
          ...c.env,
          GOOGLE_OIDC_OWNER_SUBJECT: 'bootstrap-only',
        }),
        ownerSubject: '',
      }
    : await runtimeOidcConfiguration(c.env);
  const identity = await finishLogin(
    c.env.DB,
    config,
    state,
    c.req.query('code') ?? '',
    cookieValue(c.req.raw, '__Host-bi-login'),
    now,
    fetch,
    bootstrap ? 'BOOTSTRAP' : 'LOGIN',
  );
  if (bootstrap)
    await claimBootstrapOwner(c.env.DB, state, identity, new Date());
  const existing = await c.env.DB.prepare(
    'SELECT owner_id FROM owner_users WHERE issuer=? AND subject=? AND allowlisted=1',
  )
    .bind(identity.issuer, identity.subject)
    .first();
  if (!existing) {
    const created = await c.env.DB.prepare(
      `INSERT INTO owner_users(owner_id,issuer,subject,allowlisted,created_at) SELECT ?,?,?,1,? WHERE NOT EXISTS(SELECT 1 FROM owner_users WHERE allowlisted=1) ON CONFLICT(issuer,subject) DO NOTHING`,
    )
      .bind(
        crypto.randomUUID(),
        identity.issuer,
        identity.subject,
        new Date().toISOString(),
      )
      .run();
    if (created.meta.changes !== 1) throw new Error('FORBIDDEN');
  }
  const session = await issueSession(
    c.env.DB,
    identity,
    c.env.SESSION_SIGNING_SECRET!,
    new Date(),
  );
  c.header('Set-Cookie', session.cookie, { append: true });
  c.header(
    'Set-Cookie',
    `__Host-bi-csrf=${session.csrf}; Path=/; Secure; SameSite=Lax; Max-Age=28800`,
    { append: true },
  );
  c.header(
    'Set-Cookie',
    '__Host-bi-login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
    { append: true },
  );
  const returnPath =
    cookieValue(c.req.raw, '__Host-bi-return') === '%2Fsystem%2Fconnections'
      ? '/system/connections'
      : '/';
  c.header(
    'Set-Cookie',
    '__Host-bi-return=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
    { append: true },
  );
  return c.redirect(applicationOrigin(c.env) + returnPath, 302);
});
authApp.get('/session', async (c) => {
  const context = await ownerContext(c.env, c.req.raw);
  const csrf = cookieValue(c.req.raw, '__Host-bi-csrf');
  const binding = csrf
    ? await c.env.DB.prepare(
        'SELECT session_hash FROM owner_sessions WHERE owner_id=? AND csrf_hash=? AND revoked_at IS NULL AND expires_at>?',
      )
        .bind(context.ownerId, await sha256(csrf), new Date().toISOString())
        .first()
    : null;
  return c.json({
    authenticated: true,
    owner_id: context.ownerId,
    csrf_available: Boolean(binding),
  });
});
authApp.post('/logout', async (c) => {
  await ownerContext(c.env, c.req.raw, true);
  await revokeSession(
    c.env.DB,
    cookieValue(c.req.raw, '__Host-bi-session'),
    c.env.SESSION_SIGNING_SECRET!,
    new Date(),
  );
  for (const name of ['bi-session', 'bi-csrf', 'bi-login'])
    c.header(
      'Set-Cookie',
      `__Host-${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
      { append: true },
    );
  return c.json({ authenticated: false });
});
