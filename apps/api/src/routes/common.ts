import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../env.js';
import type { AccessContext } from '../../../../packages/core/src/db/boundary.js';
import { ownerContext } from '../auth.js';
export type ApiEnvironment = {
  Bindings: Env;
  Variables: { access: AccessContext; correlation: string };
};
export function apiRouter() {
  const router = new Hono<ApiEnvironment>();
  router.use('*', async (c, next) => {
    c.set('correlation', crypto.randomUUID());
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  router.onError((error, c) => {
    const raw = error.message.includes('BACKUP_MUTATION_PAUSED')
      ? 'BACKUP_BUSY'
      : error.message;
    const forbidden = [
      'FORBIDDEN',
      'CSRF_DENIED',
      'ANALYSIS_SOURCE_PROCESSING_DENIED',
    ].includes(raw);
    const unavailable =
      raw.startsWith('ANALYSIS_PROFILE_') ||
      raw.startsWith('OPTIONAL_PROFILE_') ||
      [
        'AUTH_CONFIGURATION_REQUIRED',
        'PROVIDER_CONFIGURATION_REQUIRED',
        'QUOTA',
        'TRANSIENT',
        'AUTH',
        'PARSER',
        'CAPABILITY_NOT_AVAILABLE',
        'BACKUP_BUSY',
        'BACKUP_PILOT_LIMIT',
        'BACKUP_ROW_TOO_LARGE',
        'MODEL_NOT_CONFIGURED',
        'PROMPT_NOT_CONFIGURED',
        'ANALYSIS_SNAPSHOT_TOO_LARGE',
        'QUOTA_UNKNOWN_OR_STALE',
        'QUOTA_POLICY_NOT_CONFIGURED',
        'QUOTA_ADMISSION_DENIED',
        'QUOTA_ACCOUNT_MISMATCH',
        'ANALYSIS_CONTEXT_REQUIRED',
      ].includes(raw);
    const invalid =
      raw.startsWith('INVALID_') ||
      [
        'RESET_REQUIRED',
        'UNEXPECTED_FIELD',
        'PAYLOAD_TOO_LARGE',
        'EMPTY_SEMANTIC_PROFILE',
        'PRESET_MODULE_SCOPE_MISMATCH',
      ].includes(raw);
    const conflict = [
      'REGISTRY_VERSION_CONFLICT',
      'REGISTRY_GENERATION_CONFLICT',
      'PROMPT_QUALITY_APPROVAL_REQUIRED',
      'PROMPT_TEST_NOT_VERIFIED',
      'PROMPT_TEST_SCOPE_MISMATCH',
      'PROMPT_TEST_USAGE_NOT_VERIFIED',
      'READ_SNAPSHOT_CHANGED',
      'REVISION_CONFLICT',
      'SEMANTIC_PROFILE_REVISION_CONFLICT',
      'IMMUTABLE_SEMANTIC_PROFILE_CONFLICT',
      'IDENTITY_UNDO_DEPENDENCY',
      'STALE_FENCE',
      'IDEMPOTENCY_CONFLICT',
      'REPLAY_DENIED',
      'BACKUP_EXPIRED_OR_CLOSED',
      'BACKUP_NOT_VERIFIED',
      'BACKUP_INCOMPLETE',
      'ANALYSIS_SOURCE_NOT_ACCEPTED',
      'ANALYSIS_SOURCE_AUTHORITY_REQUIRED',
      'ANALYSIS_CONTEXT_CONFLICT',
    ].includes(raw);
    const unauthenticated = ['UNAUTHENTICATED', 'INVALID_ENCODING'].includes(
      raw,
    );
    const status = unauthenticated
      ? 401
      : forbidden
        ? 403
        : raw === 'NOT_FOUND'
          ? 404
          : conflict
            ? 409
            : invalid
              ? 422
              : unavailable
                ? 503
                : 500;
    return c.json(
      {
        code:
          status === 500
            ? 'INTERNAL_ERROR'
            : unauthenticated
              ? 'UNAUTHENTICATED'
              : forbidden
                ? 'FORBIDDEN'
                : raw,
        message:
          status === 500
            ? 'Request could not be completed.'
            : 'Request rejected.',
        correlation_id: c.get('correlation'),
      },
      status,
    );
  });
  return router;
}
export function ownerRouter() {
  const router = apiRouter();
  router.use('*', async (c, next) => {
    c.set(
      'access',
      await ownerContext(
        c.env,
        c.req.raw,
        !['GET', 'HEAD'].includes(c.req.method),
      ),
    );
    await next();
  });
  return router;
}
export async function body(
  c: Context<ApiEnvironment>,
  fields: readonly string[],
) {
  if (!/^application\/json(?:;|$)/i.test(c.req.header('Content-Type') ?? ''))
    throw new Error('INVALID_CONTENT_TYPE');
  if (Number(c.req.header('Content-Length') ?? 0) > 65536)
    throw new Error('PAYLOAD_TOO_LARGE');
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new Error('INVALID_BODY');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > 65536) {
      await reader.cancel();
      throw new Error('PAYLOAD_TOO_LARGE');
    }
    chunks.push(part.value);
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data),
    );
  } catch {
    throw new Error('INVALID_BODY');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_BODY');
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new Error('UNEXPECTED_FIELD');
  return value as Record<string, unknown>;
}
export function text(value: unknown, maximum = 2048): string {
  if (typeof value !== 'string' || !value || value.length > maximum)
    throw new Error('INVALID_INPUT');
  return value;
}
export function queryFields(
  c: Context<ApiEnvironment>,
  fields: readonly string[],
) {
  const params = new URL(c.req.url).searchParams;
  for (const key of params.keys())
    if (!fields.includes(key) || params.getAll(key).length !== 1)
      throw new Error('INVALID_FILTER');
}
