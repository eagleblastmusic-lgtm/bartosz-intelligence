import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { remoteDatabase } from '../cloudflare.mjs';
import { issueSession } from '../../../packages/core/src/auth/session.js';
import { decode64, sha256 } from '../../../packages/core/src/auth/crypto.js';
import { boundedText } from '../../../packages/core/src/http/bounded-text.js';
import {
  normalizeCue,
  type SourceAnchor,
} from '../../../packages/core/src/transcript/normalize.js';
import { requirePrivateRecoveryDirectory } from '../../db/private-directory.js';
import application from '../../../config/application.json';

type Auth = {
  schema: 'production-oracle-owner-session:1';
  origin: string;
  owner_id: string;
  owner_cookie: string;
  csrf: string;
  session_hash: string;
  expires_at: string;
};
type Intake = {
  item_id: string;
  job_id: string;
  video_id: string;
  state: string;
};
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const [phase, ...args] = process.argv.slice(2);
function arg(name: string) {
  const index = args.indexOf('--' + name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value) throw new Error('PRODUCTION_E2E_ARGUMENT_REQUIRED');
  return value;
}
function save(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
}
function loadAuth(path: string): Auth {
  const auth = JSON.parse(readFileSync(path, 'utf8')) as Auth;
  if (
    auth.schema !== 'production-oracle-owner-session:1' ||
    auth.origin !== application.app_origin ||
    !auth.owner_cookie.startsWith('__Host-bi-session=') ||
    !/^[a-f0-9]{64}$/.test(auth.session_hash) ||
    !auth.csrf ||
    Date.parse(auth.expires_at) <= Date.now()
  )
    throw new Error('PRODUCTION_E2E_AUTH_REQUIRED');
  return auth;
}

/* Existing acceptance-harness coverage validation, unchanged. */
function verifyCaptionCoverage(
  sourceText: string,
  map: {
    source_revision: string;
    source_text_hash: string;
    complete: boolean;
    offset_unit: string;
    join_separator: string;
    anchors: SourceAnchor[];
    coverage: {
      upstream_index: number;
      segment_ids: string[];
      empty: boolean;
      raw_start: number;
      raw_end: number;
      start_ms: number | null;
      end_ms: number | null;
      duplicate_of: number | null;
    }[];
  },
  sourceHash: string,
) {
  if (
    map.source_revision !== sourceHash ||
    map.source_text_hash !== sourceHash ||
    map.complete !== true ||
    map.offset_unit !== 'UTF16_CODE_UNIT' ||
    map.join_separator !== '\n' ||
    !map.coverage.length ||
    !map.anchors.length
  )
    throw new Error('E2E_COVERAGE_HEADER_INVALID');
  const anchors = new Map(
    map.anchors.map((anchor) => [anchor.segment_id, anchor]),
  );
  if (anchors.size !== map.anchors.length)
    throw new Error('E2E_DUPLICATE_ANCHOR');
  const covered = new Set<string>();
  let offset = 0;
  for (const [index, cue] of map.coverage.entries()) {
    if (
      cue.upstream_index !== index ||
      cue.raw_start !== offset ||
      !Number.isSafeInteger(cue.raw_end) ||
      cue.raw_end < offset ||
      cue.raw_end > sourceText.length ||
      !Number.isSafeInteger(cue.start_ms) ||
      !Number.isSafeInteger(cue.end_ms) ||
      cue.start_ms! < 0 ||
      cue.end_ms! < cue.start_ms!
    )
      throw new Error('E2E_CUE_TIMING_OR_OFFSET');
    const raw = sourceText.slice(cue.raw_start, cue.raw_end),
      text = normalizeCue(raw).text;
    if (!raw.trim() || cue.empty !== !text.length)
      throw new Error('E2E_CUE_TEXT_OR_EMPTY_FLAG');
    const origin =
      cue.duplicate_of === null ? cue : map.coverage[cue.duplicate_of];
    if (
      !origin ||
      (cue.duplicate_of !== null &&
        (cue.duplicate_of >= index ||
          origin.start_ms !== cue.start_ms ||
          origin.end_ms !== cue.end_ms))
    )
      throw new Error('E2E_DUPLICATE_CUE_REFERENCE');
    const parts = cue.segment_ids.map((id) => {
      const anchor = anchors.get(id);
      if (
        !anchor ||
        anchor.upstream_index !== origin.upstream_index ||
        anchor.start_ms !== cue.start_ms ||
        anchor.end_ms !== cue.end_ms ||
        anchor.source_start < origin.raw_start ||
        anchor.source_end > origin.raw_end ||
        anchor.source_end < anchor.source_start ||
        !anchor.text
      )
        throw new Error('E2E_ANCHOR_COVERAGE_MISMATCH');
      for (const span of anchor.offsets) {
        if (
          span.raw_start < origin.raw_start ||
          span.raw_end > origin.raw_end ||
          span.raw_end < span.raw_start ||
          span.normalized_start < 0 ||
          span.normalized_end > anchor.text.length ||
          span.normalized_end < span.normalized_start
        )
          throw new Error('E2E_ANCHOR_OFFSET_INVALID');
      }
      covered.add(id);
      return anchor.text;
    });
    if (parts.join('') !== text)
      throw new Error('E2E_NORMALIZED_CUE_TEXT_MISMATCH');
    offset = cue.raw_end;
    if (index + 1 < map.coverage.length) {
      if (sourceText[offset] !== '\n')
        throw new Error('E2E_JOIN_SEPARATOR_MISMATCH');
      offset++;
    }
  }
  if (offset !== sourceText.length || covered.size !== anchors.size)
    throw new Error('E2E_INCOMPLETE_COVERAGE');
  return {
    coverage_count: map.coverage.length,
    anchor_count: anchors.size,
    first_start_ms: map.coverage[0]!.start_ms,
    last_end_ms: map.coverage.at(-1)!.end_ms,
    all_source_text_offsets_and_cue_times_verified: true,
    completeness_scope: 'STORED_NORMALIZATION_COVERAGE_ONLY',
    independent_upstream_full_film_reference_checked: false,
  };
}

async function main() {
  if (
    !['prepare', 'inspect', 'run', 'revoke'].includes(phase ?? '') ||
    !args.includes('--live')
  )
    throw new Error('PRODUCTION_E2E_EXPLICIT_LIVE_REQUIRED');
  const authPath = resolve(arg('auth'));
  const output = resolve(arg('output'));
  if (existsSync(output)) throw new Error('PRODUCTION_E2E_EXISTING_OUTPUT');
  if (phase === 'prepare') {
    requirePrivateRecoveryDirectory(dirname(authPath));
    if (existsSync(authPath)) throw new Error('PRODUCTION_E2E_EXISTING_AUTH');
    const subject = process.env.GOOGLE_OIDC_OWNER_SUBJECT;
    const secret = process.env.SESSION_SIGNING_SECRET;
    if (
      !subject ||
      !secret ||
      process.env.APP_ORIGIN !== application.app_origin
    )
      throw new Error('PRODUCTION_E2E_OWNER_CONFIGURATION_REQUIRED');
    const db = remoteDatabase();
    const identity = { issuer: 'https://accounts.google.com', subject };
    const owner = await db
      .prepare(
        'SELECT owner_id FROM owner_users WHERE issuer=? AND subject=? AND allowlisted=1',
      )
      .bind(identity.issuer, subject)
      .first<{ owner_id: string }>();
    if (!owner)
      throw new Error('PRODUCTION_E2E_EXISTING_VERIFIED_OWNER_REQUIRED');
    const session = await issueSession(db, identity, secret, new Date());
    const cookie = session.cookie.split(';')[0]!;
    const sessionHash = await sha256(
      cookie.slice(cookie.indexOf('=') + 1).split('.')[0]!,
    );
    const expiresAt = new Date(Date.now() + 30 * 60000).toISOString();
    try {
      await db
        .prepare(
          'UPDATE owner_sessions SET expires_at=? WHERE owner_id=? AND session_hash=?',
        )
        .bind(expiresAt, owner.owner_id, sessionHash)
        .run();
      save(authPath, {
        schema: 'production-oracle-owner-session:1',
        origin: application.app_origin,
        owner_id: owner.owner_id,
        owner_cookie: cookie,
        csrf: session.csrf,
        session_hash: sessionHash,
        expires_at: expiresAt,
      } satisfies Auth);
    } catch {
      await db
        .prepare(
          'UPDATE owner_sessions SET revoked_at=? WHERE owner_id=? AND session_hash=?',
        )
        .bind(new Date().toISOString(), owner.owner_id, sessionHash)
        .run();
      throw new Error('PRODUCTION_E2E_AUTH_SAVE_FAILED');
    }
    save(output, {
      schema: 'production-oracle-owner-session-receipt:1',
      status: 'NORMAL_EXISTING_OWNER_SESSION_ISSUED',
      expires_at: expiresAt,
      existing_allowlisted_owner: true,
      synthetic_owner_created: false,
      signing_secret_transferred: false,
      source_jobs_submitted: 0,
    });
    return;
  }
  // Revocation remains possible after the ephemeral session expires.
  const auth =
    phase === 'revoke'
      ? (JSON.parse(readFileSync(authPath, 'utf8')) as Auth)
      : loadAuth(authPath);
  if (
    auth.schema !== 'production-oracle-owner-session:1' ||
    auth.origin !== application.app_origin ||
    !/^[a-f0-9]{64}$/.test(auth.session_hash)
  )
    throw new Error('PRODUCTION_E2E_AUTH_REQUIRED');
  if (phase === 'revoke') {
    await remoteDatabase()
      .prepare(
        'UPDATE owner_sessions SET revoked_at=? WHERE owner_id=? AND session_hash=? AND revoked_at IS NULL',
      )
      .bind(new Date().toISOString(), auth.owner_id, auth.session_hash)
      .run();
    unlinkSync(authPath);
    save(output, {
      status: 'EPHEMERAL_OWNER_SESSION_REVOKED',
      local_auth_file_removed: true,
    });
    return;
  }
  const video = arg('video');
  if (!/^[A-Za-z0-9_-]{11}$/.test(video))
    throw new Error('PRODUCTION_E2E_VIDEO_REQUIRED');
  if (phase === 'inspect') {
    const rows = await remoteDatabase()
      .prepare(
        "SELECT i.item_id,j.job_id,j.state,j.reason_code,j.created_at FROM items i LEFT JOIN jobs j ON j.owner_id=i.owner_id AND j.item_id=i.item_id AND j.task_type='FETCH_TRANSCRIPT' WHERE i.owner_id=? AND i.namespace='youtube' AND i.external_id=? ORDER BY j.created_at DESC LIMIT 3",
      )
      .bind(auth.owner_id, video)
      .all();
    save(output, {
      status: 'EXISTING_JOB_METADATA_ONLY',
      video_id: video,
      rows: rows.results,
    });
    return;
  }
  if (process.platform !== 'linux' || process.arch !== 'arm64')
    throw new Error('PRODUCTION_E2E_ORACLE_ARM64_REQUIRED');
  const startedAt = new Date().toISOString();
  const exchanges: { path: string; method: string; status: number }[] = [];
  async function request(
    path: string,
    input?: unknown,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(auth.origin + path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: auth.owner_cookie,
        Origin: application.app_origin,
        'X-CSRF-Token': auth.csrf,
        'Content-Type': 'application/json',
      },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    });
    exchanges.push({
      path,
      method: input === undefined ? 'GET' : 'POST',
      status: response.status,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('PRODUCTION_E2E_API_HTTP_' + response.status);
    }
    return JSON.parse(await boundedText(response, 2 * 1024 * 1024)) as Record<
      string,
      unknown
    >;
  }
  const intake = (await request('/api/v1/jobs/transcript', {
    locator: 'https://www.youtube.com/watch?v=' + video,
  })) as Intake;
  if (
    intake.video_id !== video ||
    !intake.item_id ||
    !intake.job_id ||
    !['PENDING', 'LEASED', 'RUNNING'].includes(intake.state)
  )
    throw new Error('PRODUCTION_E2E_NEW_SOURCE_JOB_REQUIRED');
  save(output.replace(/\.json$/, '') + '-intake.json', {
    schema: 'production-oracle-intake:1',
    ...intake,
    started_at: startedAt,
    actual_api_origin: auth.origin,
    synthetic_owner_created: false,
  });
  const deadline = Date.now() + 240000;
  let job: Record<string, unknown>;
  for (;;) {
    job = await request('/api/v1/jobs/' + intake.job_id);
    if (job.state === 'SUCCEEDED') break;
    if (
      !['PENDING', 'LEASED', 'RUNNING', 'RETRY_WAIT'].includes(
        String(job.state),
      ) ||
      Date.now() >= deadline
    )
      throw new Error('PRODUCTION_E2E_SOURCE_JOB_NOT_SUCCEEDED');
    await delay(10000);
  }
  const artifacts: Record<string, Record<string, unknown>> = {};
  const decoded: Record<string, string> = {};
  for (const kind of ['source', 'segments']) {
    let start: number | null = 0;
    let descriptor: Record<string, unknown> | undefined;
    const bodies: Uint8Array[] = [];
    let offset = 0,
      chunks = 0,
      pages = 0;
    do {
      const page = (await request(
        '/api/v1/items/' +
          intake.item_id +
          '/transcript?kind=' +
          kind +
          '&start=' +
          start,
      )) as {
        descriptor: Record<string, unknown>;
        chunks: {
          chunk_index: number;
          byte_start: number;
          byte_size: number;
          byte_hash: string;
          body_base64: string;
        }[];
        next_index: number | null;
      };
      descriptor ??= page.descriptor;
      if (
        ++pages > Number(descriptor.chunk_count) ||
        !page.chunks.length ||
        JSON.stringify(page.descriptor) !== JSON.stringify(descriptor)
      )
        throw new Error('PRODUCTION_E2E_PAGE_OR_DESCRIPTOR_INVALID');
      for (const chunk of page.chunks) {
        const bytes = decode64(chunk.body_base64);
        if (
          chunk.chunk_index !== chunks++ ||
          chunk.byte_start !== offset ||
          bytes.length !== chunk.byte_size ||
          digest(bytes) !== chunk.byte_hash
        )
          throw new Error('PRODUCTION_E2E_CHUNK_MISMATCH');
        bodies.push(bytes);
        offset += bytes.length;
        if (offset > 16 * 1024 * 1024)
          throw new Error('PRODUCTION_E2E_ARTIFACT_LIMIT');
      }
      if (page.next_index !== null && page.next_index <= start)
        throw new Error('PRODUCTION_E2E_PAGE_NOT_PROGRESSING');
      start = page.next_index;
    } while (start !== null);
    const bytes = Buffer.concat(bodies);
    if (
      chunks !== descriptor!.chunk_count ||
      bytes.length !== descriptor!.byte_size ||
      digest(bytes) !== descriptor!.content_hash
    )
      throw new Error('PRODUCTION_E2E_ARTIFACT_MISMATCH');
    const artifactPath =
      output.replace(/\.json$/, '') +
      '-' +
      kind +
      (kind === 'source' ? '.txt' : '.json');
    writeFileSync(artifactPath, bytes, { mode: 0o600, flag: 'wx' });
    artifacts[kind] = {
      ...descriptor,
      sha256: digest(bytes),
      bytes: bytes.length,
      path: artifactPath,
    };
    decoded[kind] = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  const source = artifacts.source!;
  const authority = source.authority as {
    language_code: string;
    track_kind: string;
  };
  if (
    !authority.language_code ||
    !['MANUAL', 'GENERATED'].includes(authority.track_kind)
  )
    throw new Error('PRODUCTION_E2E_SOURCE_AUTHORITY_INVALID');
  const coverage = verifyCaptionCoverage(
    decoded.source!,
    JSON.parse(decoded.segments!),
    String(source.sha256),
  );
  save(output, {
    schema: 'production-oracle-e2e:1',
    status: 'PASS_ACTUAL_PRODUCTION_API_SOURCE_READ',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    origin: auth.origin,
    video_id: video,
    item_id: intake.item_id,
    job_id: intake.job_id,
    job_state: job.state,
    artifacts,
    coverage,
    ...authority,
    exchanges,
    execution_host: {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      pid: process.pid,
      parent_pid: process.ppid,
    },
    normal_owner_session: true,
    synthetic_owner_created: false,
    source_transport: 'ORACLE_EXECUTOR',
    private_credentials_logged: false,
  });
}
try {
  await main();
  console.log(JSON.stringify({ phase, status: 'COMPLETED' }));
} catch (error) {
  const code =
    error instanceof Error &&
    /^(?:PRODUCTION_E2E_|E2E_)[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : 'PRODUCTION_E2E_SAFE_FAILURE';
  console.error(JSON.stringify({ phase, status: 'FAILED', code }));
  process.exitCode = 1;
}
