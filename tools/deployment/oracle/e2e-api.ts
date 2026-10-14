// Isolated local Worker/D1 acceptance harness. Never prints session credentials.
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { issueSession } from '../../../packages/core/src/auth/session.js';
import {
  decode64,
  randomToken,
  sha256,
} from '../../../packages/core/src/auth/crypto.js';
import type {
  Database,
  Statement,
} from '../../../packages/core/src/db/boundary.js';
import application from '../../../config/application.json';
import {
  normalizeCue,
  type SourceAnchor,
} from '../../../packages/core/src/transcript/normalize.js';

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

const [phase, ...args] = process.argv.slice(2);
function arg(name: string, fallback?: string) {
  const index = args.indexOf('--' + name);
  const value = index < 0 ? fallback : args[index + 1];
  if (!value) throw new Error('E2E_ARGUMENT_REQUIRED_' + name);
  return value;
}
const privatePath = resolve(arg('private'));
const output = resolve(arg('output'));
mkdirSync(dirname(privatePath), { recursive: true, mode: 0o700 });
function save(path: string, value: unknown, mode = 0o600) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode });
}
type Auth = {
  owner_id: string;
  owner_subject: string;
  owner_cookie: string;
  csrf: string;
  worker_credential: string;
  worker_id: string;
  session_signing_secret: string;
};

if (phase === 'seed') {
  const config = resolve(arg('config')),
    state = resolve(arg('state'));
  const query = async (
    sql: string,
    params: (string | number | null)[] = [],
  ) => {
    // This fixed local adapter is used only to seed an isolated local database.
    let at = 0;
    const rendered = sql.replaceAll('?', () => {
      const value = params[at++];
      if (value === null) return 'NULL';
      if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
      if (typeof value === 'string')
        return "'" + value.replaceAll("'", "''") + "'";
      throw new Error('E2E_BINDING_INVALID');
    });
    if (at !== params.length) throw new Error('E2E_BINDING_COUNT');
    const file = resolve(dirname(privatePath), 'seed-' + randomUUID() + '.sql');
    writeFileSync(file, rendered, { mode: 0o600 });
    try {
      const run = spawnSync(
        process.execPath,
        [
          resolve('node_modules/wrangler/bin/wrangler.js'),
          'd1',
          'execute',
          'oracle-local-e2e',
          '--local',
          '--persist-to',
          state,
          '--config',
          config,
          '--file',
          file,
          '--json',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 60000,
          env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
        },
      );
      if (run.status !== 0) throw new Error('E2E_LOCAL_SEED_SQL_FAILED');
      const result = JSON.parse(run.stdout) as {
        results: Record<string, unknown>[];
        meta: { changes: number };
        success: boolean;
      }[];
      if (result.length !== 1 || result[0]!.success !== true)
        throw new Error('E2E_LOCAL_SEED_RESULT');
      return result[0]!;
    } finally {
      unlinkSync(file);
    }
  };
  class LocalStatement implements Statement {
    constructor(
      private sql: string,
      private params: (string | number | null)[] = [],
    ) {}
    bind(...params: (string | number | null)[]) {
      return new LocalStatement(this.sql, params);
    }
    async first<T = Record<string, unknown>>(
      column?: string,
    ): Promise<T | null> {
      const row = (await query(this.sql, this.params)).results[0];
      return row ? ((column ? row[column] : row) as T) : null;
    }
    async all<T = Record<string, unknown>>() {
      return { results: (await query(this.sql, this.params)).results as T[] };
    }
    async run() {
      return { meta: (await query(this.sql, this.params)).meta };
    }
  }
  const db: Database = {
    prepare: (sql) => new LocalStatement(sql),
    batch: async () => {
      throw new Error('E2E_SEED_BATCH_NOT_USED');
    },
  };
  const owner = randomUUID(),
    subject = 'e2e-' + randomUUID(),
    credential = randomToken(),
    secret = randomToken(),
    now = new Date();
  await db
    .prepare('INSERT INTO owner_users VALUES(?,?,?,1,?)')
    .bind(owner, 'https://accounts.google.com', subject, now.toISOString())
    .run();
  await db
    .prepare(
      'INSERT INTO worker_identities VALUES(?,?,?,\'["FETCH_TRANSCRIPT"]\',?,NULL)',
    )
    .bind(
      'oracle-e2e-' + owner,
      owner,
      await sha256(credential),
      now.toISOString(),
    )
    .run();
  const session = await issueSession(
    db,
    { issuer: 'https://accounts.google.com', subject },
    secret,
    now,
  );
  const auth: Auth = {
    owner_id: owner,
    owner_subject: subject,
    owner_cookie: session.cookie.split(';')[0]!,
    csrf: session.csrf,
    worker_credential: credential,
    worker_id: 'oracle-e2e-' + owner,
    session_signing_secret: secret,
  };
  save(privatePath, auth);
  save(output, {
    schema: 'oracle-e2e-seed:1',
    status: 'PASS_ISOLATED_OWNER_WORKER_SEED',
    scopes: ['FETCH_TRANSCRIPT'],
    real_google_login: false,
    production_mutations: 0,
    actual_youtube_cookie_reads: 0,
  });
} else if (phase === 'intake' || phase === 'verify') {
  const auth = JSON.parse(readFileSync(privatePath, 'utf8')) as Auth;
  const base = arg('base', 'http://127.0.0.1:8789');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))
    throw new Error('E2E_LOOPBACK_REQUIRED');
  async function request(path: string, input?: unknown) {
    const response = await fetch(base + path, {
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
    if (!response.ok) throw new Error('E2E_API_HTTP_' + response.status);
    return response.json() as Promise<Record<string, unknown>>;
  }
  if (phase === 'intake') {
    const job = await request('/api/v1/jobs/transcript', {
      locator: arg('video'),
    });
    save(output, {
      schema: 'oracle-e2e-intake:1',
      status: 'PASS_JOB_ENQUEUED',
      ...job,
    });
  } else {
    const intake = JSON.parse(readFileSync(arg('input'), 'utf8')) as {
      item_id: string;
      job_id: string;
      video_id: string;
    };
    const job = await request('/api/v1/jobs/' + intake.job_id);
    if (job.state !== 'SUCCEEDED') throw new Error('E2E_JOB_NOT_SUCCEEDED');
    const artifacts: Record<string, unknown> = {};
    const decoded: Record<string, string> = {};
    for (const kind of ['source', 'segments']) {
      let start: number | null = 0,
        descriptor: Record<string, unknown> | undefined;
      const bodies: Uint8Array[] = [];
      let offset = 0;
      let pages = 0;
      do {
        const page = (await request(
          `/api/v1/items/${intake.item_id}/transcript?kind=${kind}&start=${start}`,
        )) as unknown as {
          descriptor: Record<string, unknown>;
          chunks: {
            byte_start: number;
            byte_size: number;
            byte_hash: string;
            body_base64: string;
          }[];
          next_index: number | null;
        };
        descriptor ??= page.descriptor;
        if (++pages > Number(descriptor.chunk_count) || page.chunks.length < 1)
          throw new Error('E2E_PAGE_LIMIT');
        if (JSON.stringify(page.descriptor) !== JSON.stringify(descriptor))
          throw new Error('E2E_DESCRIPTOR_CHANGED');
        for (const chunk of page.chunks) {
          const body = decode64(chunk.body_base64);
          if (
            chunk.byte_start !== offset ||
            body.length !== chunk.byte_size ||
            createHash('sha256').update(body).digest('hex') !== chunk.byte_hash
          )
            throw new Error('E2E_CHUNK_MISMATCH');
          bodies.push(body);
          offset += body.length;
        }
        if (page.next_index !== null && page.next_index <= start)
          throw new Error('E2E_PAGE_NOT_PROGRESSING');
        start = page.next_index;
      } while (start !== null);
      const body = Buffer.concat(bodies);
      const hash = createHash('sha256').update(body).digest('hex');
      if (
        body.length !== descriptor!.byte_size ||
        hash !== descriptor!.content_hash
      )
        throw new Error('E2E_ARTIFACT_MISMATCH');
      const path =
        output.replace(/\.json$/, '') +
        '-' +
        kind +
        (kind === 'source' ? '.txt' : '.json');
      writeFileSync(path, body, { mode: 0o600 });
      artifacts[kind] = {
        ...descriptor,
        sha256: hash,
        bytes: body.length,
        path,
      };
      decoded[kind] = body.toString('utf8');
    }
    const source = artifacts.source as {
      sha256: string;
      authority: { language_code: string; track_kind: string };
    };
    if (
      !source.authority.language_code ||
      !['MANUAL', 'GENERATED'].includes(source.authority.track_kind)
    )
      throw new Error('E2E_SOURCE_AUTHORITY_INVALID');
    const coverage = verifyCaptionCoverage(
      decoded.source!,
      JSON.parse(decoded.segments!),
      source.sha256,
    );
    save(output, {
      schema: 'oracle-e2e-read-verification:1',
      status: 'PASS_ACCEPTED_ARTIFACT_HTTP_READ',
      video_id: intake.video_id,
      job_id: intake.job_id,
      item_id: intake.item_id,
      job_state: job.state,
      artifacts,
      coverage,
      language_code: source.authority.language_code,
      track_kind: source.authority.track_kind,
      production_mutations: 0,
      source_transport: 'ORACLE_EXECUTOR',
      private_credentials_logged: false,
    });
  }
} else throw new Error('E2E_PHASE_INVALID');
console.log(JSON.stringify({ phase, status: 'COMPLETED', proof: output }));
