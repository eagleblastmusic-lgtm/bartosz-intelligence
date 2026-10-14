/** Minimal CDP pipe transport: no caption library, HTTP impersonation or saved profile. */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import {
  EngineFailure,
  fail,
  maxBytes,
  digest,
  obj,
  snapshotProjection,
  listingFailure,
} from './engine.js';
import type { Snapshot } from './engine.js';

type Event = {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
};
class PipeCdp {
  private serial = 0;
  private buffer = Buffer.alloc(0);
  private pending = new Map<
    number,
    {
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  onEvent: (e: Event) => void = () => {};
  constructor(
    private child: ChildProcess,
    private input: Writable,
    output: Readable,
  ) {
    input.on('error', () => this.stop());
    child.once('error', () => this.stop());
    child.once('exit', () => this.stop());
    output.on('error', () => this.stop());
    output.on('data', (chunk: Buffer) => {
      if (this.buffer.length + chunk.length > 16 * 1024 * 1024) {
        this.stop(new EngineFailure('TOO_LARGE', 'CDP_MESSAGE_LIMIT'));
        child.kill();
        return;
      }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let end: number;
      while ((end = this.buffer.indexOf(0)) >= 0) {
        const body = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end + 1);
        let m: Record<string, unknown>;
        try {
          m = obj(JSON.parse(body.toString('utf8')));
        } catch {
          this.stop(
            new EngineFailure('TECHNICAL_FAILURE', 'CDP_INVALID_MESSAGE'),
          );
          return;
        }
        if (typeof m.id === 'number') {
          const waiting = this.pending.get(m.id);
          if (!waiting) continue;
          this.pending.delete(m.id);
          clearTimeout(waiting.timer);
          if (m.error)
            waiting.reject(
              new EngineFailure('TECHNICAL_FAILURE', 'CDP_COMMAND_FAILED'),
            );
          else waiting.resolve(obj(m.result ?? {}));
        } else if (typeof m.method === 'string') {
          this.onEvent({
            method: m.method,
            params: obj(m.params ?? {}),
            sessionId:
              typeof m.sessionId === 'string' ? m.sessionId : undefined,
          });
        }
      }
    });
  }
  call(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeout = 10000,
  ) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineFailure('TIMEOUT', 'CDP_COMMAND_TIMEOUT'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.input.write(
        JSON.stringify({ id, method, params, sessionId }) + '\0',
      );
    });
  }
  stop(
    e: Error = new EngineFailure('BROWSER_UNAVAILABLE', 'BROWSER_PIPE_CLOSED'),
  ) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
}
export type NativeDiagnostics = {
  browser_version?: string;
  fresh_profile?: boolean;
  profile_removed?: boolean;
  sandbox?: boolean;
  requests?: number;
  transcript_requests?: number;
  transport_complete?: boolean;
  network?: Record<string, unknown>[];
  documents?: {
    host: string;
    path: string;
    http_status: number;
    is_requested_watch: boolean;
  }[];
  player_state?: {
    video_id: string | null;
    playability_status: string | null;
    reason: string | null;
    subreason: string | null;
    tracks_explicit: boolean;
    track_count: number;
  };
  snapshot?: Snapshot;
  dom?: { ok: boolean; cue_count: number; code: string | null };
};
const snapshotScript = `(() => {
  let p; try { p = document.querySelector('#movie_player')?.getPlayerResponse?.(); } catch {}
  p ||= window.ytInitialPlayerResponse;
  const c = p?.captions?.playerCaptionsTracklistRenderer;
  const text = n => typeof n?.simpleText === 'string' ? n.simpleText :
    Array.isArray(n?.runs) ? n.runs.map(r => r.text || '').join('') : '';
  const error = p?.playabilityStatus?.errorScreen?.playerErrorMessageRenderer;
  return {video_id:p?.videoDetails?.videoId || '',playability_status:p?.playabilityStatus?.status || null,
    reason:p?.playabilityStatus?.reason || text(error?.reason) || null,
    subreason:text(error?.subreason) || null,
    tracks_explicit:Array.isArray(c?.captionTracks), original_language:null,
    tracks:(c?.captionTracks || []).map(t => {
      let translated = null; try { translated = new URL(t.baseUrl).searchParams.has('tlang'); } catch {}
      return {vss_id:t.vssId || null,language_code:t.languageCode,
        kind:t.kind === 'asr' ? 'GENERATED' : t.kind === undefined ? 'MANUAL' : 'UNKNOWN',
        name:text(t.name),is_translated:translated};
    })};
})()`;
const openPanelScript = `(() => {
  const visible = e => !!e && e.isConnected && e.getClientRects().length &&
    getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const buttons = [...document.querySelectorAll('button, ytd-button-renderer, yt-button-view-model')]
    .filter(e => visible(e) && /^(Show transcript|Pokaż transkrypcję)$/i.test((e.innerText || e.getAttribute('aria-label') || '').trim()));
  const inner = buttons.filter(e => !buttons.some(b => b !== e && e.contains(b)));
  if (inner.length !== 1) return {clicked:false, count:inner.length};
  inner[0].click(); return {clicked:true, count:1};
})()`;
const expandDescriptionScript = `(() => {
  const e = document.querySelector('ytd-watch-metadata #expand, ytd-text-inline-expander #expand');
  if (e && e.getClientRects().length) { e.click(); return true; } return false;
})()`;
type SessionCookie = {
  name: string;
  value: string;
  domain: 'youtube.com' | '.youtube.com';
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
};
function sessionCookieParams(input: unknown): SessionCookie[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 64)
    fail('INVALID_INPUT', 'SESSION_COOKIE_COUNT_INVALID');
  const fields = new Set([
    'name',
    'value',
    'domain',
    'path',
    'secure',
    'httpOnly',
    'sameSite',
    'expires',
  ]);
  return input.map((inputCookie) => {
    const cookie = obj(inputCookie);
    if (
      Object.keys(cookie).some((key) => !fields.has(key)) ||
      (cookie.domain !== 'youtube.com' && cookie.domain !== '.youtube.com') ||
      typeof cookie.name !== 'string' ||
      !/^[!#$%&'*+\-.^_`|~a-zA-Z0-9]{1,256}$/.test(cookie.name) ||
      typeof cookie.value !== 'string' ||
      cookie.value.length > 4096 ||
      /[^\x20-\x7e]|;/.test(cookie.value) ||
      (cookie.path !== undefined &&
        (typeof cookie.path !== 'string' ||
          !/^\/[^\x00-\x20\x7f;]{0,1023}$/.test(cookie.path))) ||
      ['secure', 'httpOnly'].some(
        (key) => cookie[key] !== undefined && typeof cookie[key] !== 'boolean',
      ) ||
      (cookie.sameSite !== undefined &&
        !['Strict', 'Lax', 'None'].includes(String(cookie.sameSite))) ||
      (cookie.expires !== undefined &&
        (typeof cookie.expires !== 'number' ||
          !Number.isFinite(cookie.expires)))
    )
      fail('INVALID_INPUT', 'SESSION_COOKIE_INVALID');
    return cookie as SessionCookie;
  });
}
export async function captureNative(options: {
  executable: string;
  video: string;
  timeoutMs: number;
  signal?: AbortSignal;
  domReaderPath: string;
  diagnostics: NativeDiagnostics;
  /** Loopback is exclusively a replay harness. It cannot set acquisition=live. */
  replayOrigin?: string;
  allowNoSandbox?: boolean;
  /** One-shot diagnostic input only; never retained in diagnostics. */
  sessionCookies?: unknown;
  maxPageRequests?: number;
}) {
  if (!isAbsolute(options.executable) || /[\r\n\0]/.test(options.executable))
    fail('INVALID_INPUT', 'ABSOLUTE_BROWSER_PATH_REQUIRED');
  if (options.signal?.aborted) fail('CANCELLED', 'ABORTED_BEFORE_BROWSER');
  if (options.timeoutMs < 100 || options.timeoutMs > 45000)
    fail('INVALID_INPUT', 'TIMEOUT_OUT_OF_RANGE');
  if (
    options.replayOrigin &&
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(options.replayOrigin)
  )
    fail('INVALID_INPUT', 'LOOPBACK_REPLAY_REQUIRED');
  if (options.allowNoSandbox && !options.replayOrigin)
    fail('INVALID_INPUT', 'LIVE_REQUIRES_BROWSER_SANDBOX');
  const cookies =
    options.sessionCookies === undefined
      ? undefined
      : sessionCookieParams(options.sessionCookies);
  const maxPageRequests = options.maxPageRequests ?? 256;
  if (
    !Number.isInteger(maxPageRequests) ||
    maxPageRequests < 1 ||
    maxPageRequests > 256
  )
    fail('INVALID_INPUT', 'PAGE_REQUEST_LIMIT_INVALID');
  const d = options.diagnostics;
  d.network = [];
  d.requests = 0;
  d.transcript_requests = 0;
  const profile = await mkdtemp(join(tmpdir(), 'bartosz-ote-profile-'));
  d.fresh_profile = true;
  d.sandbox = !options.allowNoSandbox;
  let child: ChildProcess | undefined, cdp: PipeCdp | undefined;
  let terminal: EngineFailure | undefined, session: string | undefined;
  const halt = (e: EngineFailure) => {
    terminal ??= e;
  };
  const abort = () => {
    halt(new EngineFailure('CANCELLED', 'ABORT_SIGNAL'));
    child?.kill();
  };
  const timer = setTimeout(() => {
    halt(new EngineFailure('TIMEOUT', 'NATIVE_DEADLINE'));
    child?.kill();
  }, options.timeoutMs);
  options.signal?.addEventListener('abort', abort, { once: true });
  const deadline = Date.now() + options.timeoutMs;
  const check = () => {
    if (terminal) throw terminal;
    if (Date.now() >= deadline) fail('TIMEOUT', 'NATIVE_DEADLINE');
  };
  const pause = async () => {
    check();
    await new Promise((r) => setTimeout(r, 40));
    check();
  };
  try {
    child = spawn(
      options.executable,
      [
        '--headless=new',
        '--remote-debugging-pipe',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-breakpad',
        '--disable-dev-shm-usage',
        '--autoplay-policy=user-gesture-required',
        ...(options.allowNoSandbox ? ['--no-sandbox'] : []),
        'about:blank',
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
        detached: process.platform === 'linux',
        windowsHide: true,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([k]) =>
            [
              'PATH',
              'SYSTEMROOT',
              'WINDIR',
              'TEMP',
              'TMP',
              'TMPDIR',
              'HOME',
            ].includes(k.toUpperCase()),
          ),
        ),
      },
    );
    let stderrBytes = 0;
    child.stderr!.on('data', (b: Buffer) => {
      stderrBytes += b.length;
      if (stderrBytes > maxBytes) {
        halt(new EngineFailure('TOO_LARGE', 'BROWSER_STDERR_LIMIT'));
        child?.kill();
      }
    });
    cdp = new PipeCdp(
      child,
      child.stdio[3] as Writable,
      child.stdio[4] as Readable,
    );
    const browserVersion = await cdp.call('Browser.getVersion');
    d.browser_version = String(browserVersion.product)
      .replace(/[^a-zA-Z0-9./ -]/g, '')
      .slice(0, 100);
    // Reuse the single page created by our own fresh-profile launch. Creating a
    // second target needlessly adds a renderer and exceeded the ARM64 RSS budget.
    const targets = await cdp.call('Target.getTargets');
    const pages = (targets.targetInfos as Record<string, unknown>[]).filter(
      (t) => t.type === 'page',
    );
    if (pages.length !== 1)
      fail('BROWSER_UNAVAILABLE', 'SINGLE_FRESH_PAGE_REQUIRED');
    const attached = await cdp.call('Target.attachToTarget', {
      targetId: pages[0]!.targetId,
      flatten: true,
    });
    session = String(attached.sessionId);
    const call = (method: string, params: Record<string, unknown> = {}) => {
      check();
      return cdp!.call(
        method,
        params,
        session,
        Math.max(1, Math.min(8000, deadline - Date.now())),
      );
    };
    const evaluate = async (expression: string) => {
      const r = await call('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) fail('UPSTREAM_CHANGED', 'PAGE_SCRIPT_FAILED');
      return obj(r.result).value;
    };
    type Request = { path: string; status?: number; bytes: number };
    const relevant = new Map<string, Request>();
    let body: string | undefined;
    let totalBytes = 0;
    const onEvent = async (e: Event) => {
      if (e.sessionId !== session) return;
      const p = e.params;
      if (e.method === 'Fetch.requestPaused') {
        const r = obj(p.request),
          u = new URL(String(r.url));
        d.requests = (d.requests ?? 0) + 1;
        let allow = !terminal && d.requests <= maxPageRequests;
        if (options.replayOrigin) allow &&= u.origin === options.replayOrigin;
        else
          allow &&=
            u.protocol === 'https:' &&
            [
              'youtube.com',
              'ytimg.com',
              'google.com',
              'googlevideo.com',
              'gstatic.com',
            ].some(
              (host) => u.hostname === host || u.hostname.endsWith('.' + host),
            );
        if (
          p.resourceType === 'Media' ||
          /(^|\.)googlevideo\.com$/.test(u.hostname) ||
          u.pathname === '/api/timedtext'
        )
          allow = false;
        if (/get_transcript$/.test(u.pathname)) {
          d.transcript_requests = (d.transcript_requests ?? 0) + 1;
          if (d.transcript_requests > 1) {
            allow = false;
            halt(
              new EngineFailure('TECHNICAL_FAILURE', 'NATIVE_REQUEST_BUDGET'),
            );
          }
        }
        if (d.requests > maxPageRequests)
          halt(new EngineFailure('TOO_LARGE', 'PAGE_REQUEST_BUDGET'));
        // Abort unrequested media and foreign hosts without retaining their URLs.
        await cdp!.call(
          allow ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          allow
            ? { requestId: p.requestId }
            : { requestId: p.requestId, errorReason: 'Aborted' },
          session,
          2000,
        );
      }
      if (e.method === 'Network.responseReceived') {
        const r = obj(p.response),
          u = new URL(String(r.url));
        const requestedWatch =
          p.type === 'Document' &&
          u.origin === (options.replayOrigin ?? 'https://www.youtube.com') &&
          u.pathname === '/watch' &&
          u.searchParams.get('v') === options.video;
        if (p.type === 'Document') {
          d.documents ??= [];
          if (d.documents.length < 64)
            d.documents.push({
              host: u.hostname,
              path: requestedWatch ? '/watch' : '/[document]',
              http_status: Number(r.status),
              is_requested_watch: requestedWatch,
            });
        }
        if (/get_transcript$/.test(u.pathname))
          relevant.set(String(p.requestId), {
            path: '/youtubei/v1/get_transcript',
            status: Number(r.status),
            bytes: 0,
          });
        if (requestedWatch && [401, 403, 429].includes(Number(r.status)))
          halt(
            new EngineFailure(
              Number(r.status) === 429
                ? 'RATE_LIMITED'
                : Number(r.status) === 401
                  ? 'AUTH_REQUIRED'
                  : 'SOURCE_REFUSED',
              'WATCH_HTTP_' + Number(r.status),
            ),
          );
      }
      if (e.method === 'Network.dataReceived') {
        totalBytes += Number(p.dataLength ?? 0);
        const r = relevant.get(String(p.requestId));
        if (r) r.bytes += Number(p.dataLength ?? 0);
        if ((r && r.bytes > maxBytes) || totalBytes > 32 * 1024 * 1024) {
          halt(new EngineFailure('TOO_LARGE', 'NETWORK_BODY_LIMIT'));
          await cdp!.call('Page.stopLoading', {}, session, 1000);
        }
      }
      if (
        e.method === 'Network.loadingFailed' &&
        relevant.has(String(p.requestId))
      )
        halt(new EngineFailure('PARTIAL_RESPONSE', 'CAPTION_TRANSPORT_FAILED'));
      if (
        e.method === 'Network.loadingFinished' &&
        relevant.has(String(p.requestId))
      ) {
        const r = relevant.get(String(p.requestId))!;
        const response = await call('Network.getResponseBody', {
          requestId: p.requestId,
        });
        const bytes = response.base64Encoded
          ? Buffer.from(String(response.body), 'base64')
          : Buffer.from(String(response.body), 'utf8');
        if (bytes.length > maxBytes) {
          halt(new EngineFailure('TOO_LARGE', 'CAPTION_BODY_LIMIT'));
          return;
        }
        const receipt: Record<string, unknown> = {
          path: r.path,
          http_status: r.status,
          bytes: bytes.length,
          raw_sha256: digest(bytes),
          transport_complete: true,
        };
        // Error projection contains stable codes only, no opaque transport context.
        try {
          const error = obj(JSON.parse(bytes.toString('utf8'))).error;
          if (error) {
            const er = obj(error);
            receipt.source_error = {
              code: Number(er.code),
              status: /^[A-Z_]+$/.test(String(er.status))
                ? String(er.status)
                : null,
            };
          }
        } catch {
          /* Body parser will classify a malformed response. */
        }
        d.network!.push(receipt);
        d.transport_complete = true;
        if (r.status === 429)
          halt(new EngineFailure('RATE_LIMITED', 'PANEL_HTTP_429'));
        else if (r.status === 401)
          halt(new EngineFailure('AUTH_REQUIRED', 'PANEL_HTTP_401'));
        else if (r.status !== 200 && r.status !== 400)
          halt(new EngineFailure('SOURCE_REFUSED', 'PANEL_HTTP_' + r.status));
        body = bytes.toString('utf8');
      }
    };
    cdp.onEvent = (e) => {
      void onEvent(e).catch((e) =>
        halt(
          e instanceof EngineFailure
            ? e
            : new EngineFailure('TECHNICAL_FAILURE', 'BROWSER_EVENT_FAILED'),
        ),
      );
    };
    await call('Network.enable', {
      maxTotalBufferSize: 8 * 1024 * 1024,
      maxResourceBufferSize: maxBytes,
    });
    if (cookies) await call('Network.setCookies', { cookies });
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await call('Page.navigate', {
      url: `${options.replayOrigin ?? 'https://www.youtube.com'}/watch?v=${options.video}`,
    });
    let snapshot: Snapshot | undefined;
    while (!snapshot) {
      check();
      const location = String(await evaluate('location.href'));
      if (/^https:\/\/(consent|accounts)\./.test(location))
        fail('AUTH_REQUIRED', 'CONSENT_OR_LOGIN_SCREEN');
      const candidate = await evaluate(snapshotScript);
      if (candidate) {
        const state = obj(candidate),
          status = String(state.playability_status ?? '');
        d.player_state = {
          video_id:
            typeof state.video_id === 'string' &&
            /^[\w-]{11}$/.test(state.video_id)
              ? state.video_id
              : null,
          playability_status: /^[A-Z_]+$/.test(status) ? status : null,
          reason:
            typeof state.reason === 'string'
              ? state.reason.slice(0, 512)
              : null,
          subreason:
            typeof state.subreason === 'string'
              ? state.subreason.slice(0, 512)
              : null,
          tracks_explicit: state.tracks_explicit === true,
          track_count: Array.isArray(state.tracks) ? state.tracks.length : 0,
        };
        if (!state.video_id && status && status !== 'OK')
          fail(
            status === 'LOGIN_REQUIRED' ? 'AUTH_REQUIRED' : 'SOURCE_REFUSED',
            status === 'LOGIN_REQUIRED'
              ? 'PLAYER_LOGIN_REQUIRED_WITHOUT_ID'
              : 'PLAYER_REFUSED_WITHOUT_ID',
          );
      }
      if (candidate && obj(candidate).video_id)
        snapshot = snapshotProjection(candidate, options.video);
      else await pause();
    }
    d.snapshot = snapshot;
    const unavailable = listingFailure(snapshot);
    if (unavailable) throw unavailable;
    await evaluate(expandDescriptionScript);
    let clicked = false;
    while (!clicked) {
      const r = obj(await evaluate(openPanelScript));
      if (Number(r.count) > 1)
        fail('UPSTREAM_CHANGED', 'TRANSCRIPT_BUTTON_AMBIGUOUS');
      clicked = r.clicked === true;
      if (!clicked) await pause();
    }
    while (body === undefined) await pause();
    check();
    // Error bodies have no DOM rows. Return directly for exact source-error parsing.
    try {
      if (obj(JSON.parse(body)).error) return { body, snapshot, dom: null };
    } catch {
      return { body, snapshot, dom: null };
    }
    const script = await readFile(options.domReaderPath, 'utf8');
    const dom = await evaluate(
      `${script}\nreadTranscriptPanel(${JSON.stringify(options.video)}, {timeoutMs:2000,scrollTimeoutMs:3000,maxScrollSteps:100})`,
    );
    const row = obj(dom);
    d.dom = {
      ok: row.ok === true,
      cue_count: Array.isArray(row.segments) ? row.segments.length : 0,
      code:
        typeof row.code === 'string' && /^[A-Z_]+$/.test(row.code)
          ? row.code
          : null,
    };
    // Guard navigation or track mutation across the complete native transaction.
    const finalSnapshot = snapshotProjection(
      await evaluate(snapshotScript),
      options.video,
    );
    if (JSON.stringify(finalSnapshot) !== JSON.stringify(snapshot))
      fail('IDENTITY_MISMATCH', 'PLAYER_CHANGED_DURING_TRANSACTION');
    return { body, snapshot, dom };
  } catch (e) {
    if (terminal) throw terminal;
    throw e;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    if (cdp) {
      await cdp.call('Browser.close', {}, undefined, 500).catch(() => {});
      cdp.stop();
    }
    if (child?.pid) {
      try {
        if (process.platform === 'linux') process.kill(-child.pid, 'SIGKILL');
        else child.kill();
      } catch {
        /* Exited. */
      }
      if (child.exitCode === null)
        await Promise.race([
          new Promise<void>((r) => child!.once('exit', () => r())),
          new Promise<void>((r) => setTimeout(r, 500)),
        ]);
    }
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 100,
    });
    d.profile_removed = true;
  }
}
