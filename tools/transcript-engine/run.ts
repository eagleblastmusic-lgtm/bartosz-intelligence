import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  analyze,
  digest,
  obj,
  parseJson,
  fail,
  EngineFailure,
  maxBytes,
  version,
} from './engine.js';
import { publicVideoId } from '../probes/source-probe.js';
import { captureNative } from './browser.js';
import type { NativeDiagnostics } from './browser.js';
import { obtainPublisher } from './publisher.js';

async function boundedFile(path: string, limit = maxBytes) {
  if ((await stat(path)).size > limit) fail('TOO_LARGE', 'INPUT_FILE_LIMIT');
  const bytes = await readFile(path);
  if (bytes.length > limit) fail('TOO_LARGE', 'INPUT_FILE_LIMIT');
  return bytes.toString('utf8');
}
export async function main(args: string[]) {
  if (
    args.length !== 4 ||
    !['replay', 'native', 'publisher'].includes(args[0]!)
  )
    fail('INVALID_INPUT', 'USAGE_MODE_VIDEO_CONFIG_NEW_OUTPUT_DIRECTORY');
  const [mode, videoInput, configInput, outputInput] = args as [
    string,
    string,
    string,
    string,
  ];
  const video = publicVideoId(videoInput),
    configPath = resolve(configInput),
    out = resolve(outputInput);
  const config = obj(parseJson(await boundedFile(configPath, 65536)));
  if (config.schema !== 'ote-source:1')
    fail('INVALID_INPUT', 'SOURCE_CONFIG_SCHEMA_REQUIRED');
  // Exclusive result directory prevents stale files from a previous failed run.
  await mkdir(out, { recursive: false });
  const start = performance.now(),
    cpu = process.cpuUsage();
  const nativeDiagnostics: NativeDiagnostics = {};
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let report: Record<string, unknown>;
  try {
    let reference: unknown;
    if (config.reference_path !== undefined) {
      if (typeof config.reference_path !== 'string')
        fail('INVALID_INPUT', 'REFERENCE_PATH_INVALID');
      const raw = await boundedFile(
        resolve(dirname(configPath), config.reference_path),
      );
      if (digest(raw) !== config.reference_sha256)
        fail('IDENTITY_MISMATCH', 'REFERENCE_FILE_HASH_MISMATCH');
      reference = parseJson(raw);
    }
    let body: string,
      snapshot: unknown,
      dom: unknown = null;
    if (mode === 'replay') {
      if (
        typeof config.path !== 'string' ||
        typeof config.snapshot_path !== 'string'
      )
        fail('INVALID_INPUT', 'REPLAY_PATHS_REQUIRED');
      body = await boundedFile(resolve(dirname(configPath), config.path));
      snapshot = parseJson(
        await boundedFile(resolve(dirname(configPath), config.snapshot_path)),
      );
    } else {
      if (
        config.diagnostic_video_id !== undefined &&
        config.diagnostic_video_id !== video
      )
        fail('IDENTITY_MISMATCH', 'DIAGNOSTIC_VIDEO_MISMATCH');
      // Public native diagnostics do not require a per-video permission document.
      // Actual source refusal/login/consent remains terminal in captureNative.
      if (process.env.BARTOSZ_OTE_SUPERVISED !== '1')
        fail('INVALID_INPUT', 'PROCESS_TREE_SUPERVISOR_REQUIRED');
      if (mode === 'publisher') {
        const captured = await obtainPublisher(
          video,
          config,
          abort.signal,
          out,
        );
        body = captured.body;
        snapshot = captured.snapshot;
        await writeFile(
          resolve(out, 'publisher-provenance.json'),
          JSON.stringify(captured.provenance, null, 2) + '\n',
          { mode: 0o600 },
        );
      } else {
        if (typeof config.browser_executable !== 'string')
          fail('BROWSER_UNAVAILABLE', 'BROWSER_EXECUTABLE_REQUIRED');
        let sessionCookies: unknown;
        if (config.session_cookie_path !== undefined) {
          if (
            typeof config.session_cookie_path !== 'string' ||
            video !== 'aircAruvnKk' ||
            config.diagnostic_video_id !== video ||
            config.sandbox !== true
          )
            fail('INVALID_INPUT', 'ONE_SHOT_SESSION_SCOPE_REQUIRED');
          sessionCookies = parseJson(
            await boundedFile(
              resolve(dirname(configPath), config.session_cookie_path),
              65536,
            ),
          );
        }
        const captured = await captureNative({
          executable: config.browser_executable,
          video,
          timeoutMs: sessionCookies === undefined ? 30000 : 45000,
          signal: abort.signal,
          diagnostics: nativeDiagnostics,
          domReaderPath: fileURLToPath(
            new URL('./dom-reader.js', import.meta.url),
          ),
          allowNoSandbox: config.sandbox === false,
          sessionCookies,
          maxPageRequests: sessionCookies === undefined ? 256 : 128,
        });
        body = captured.body;
        snapshot = captured.snapshot;
        dom = captured.dom;
      }
    }
    if (abort.signal.aborted) fail('CANCELLED', 'ABORT_SIGNAL');
    const parsed = analyze({
      video,
      body,
      snapshot,
      reference,
      live: mode === 'native',
      transportComplete:
        mode !== 'native' || nativeDiagnostics.transport_complete === true,
      format:
        mode === 'native'
          ? 'panel'
          : mode === 'publisher'
            ? 'json3'
            : (config.format as
                'panel' | 'json3' | 'recorded-en' | 'recorded-dom'),
      expectedTrackId:
        typeof config.expected_track_id === 'string'
          ? config.expected_track_id
          : undefined,
    });
    if (mode === 'publisher') {
      parsed.result.accepted = false;
      Object.assign(parsed.result, {
        acquisition: 'PUBLISHER_CAPTIONS',
        acquisition_status:
          parsed.result.status === 'PARTIAL'
            ? 'PARTIAL'
            : 'PASS_LIVE_PUBLISHER',
      });
      Object.assign(
        parsed.result.provenance,
        {
          normalized_projection_sha256: parsed.result.provenance.raw_sha256,
          persistence: 'RAW_PUBLISHER_SOURCE_AND_NORMALIZED_PROJECTION',
        },
        JSON.parse(
          await readFile(resolve(out, 'publisher-provenance.json'), 'utf8'),
        ),
      );
    }
    if (mode === 'native') {
      const d = dom ? obj(dom) : {};
      const rows = Array.isArray(d.segments) ? d.segments : [];
      const agree =
        d.ok === true &&
        rows.length === parsed.result.segments.length &&
        rows.every((v, i) => {
          const r = obj(v),
            c = parsed.result.segments[i]!;
          return (
            r.text === c.text && r.start === Math.floor(c.start_ms! / 1000)
          );
        });
      if (!agree) {
        parsed.result.accepted = false;
        parsed.result.status = 'PARTIAL';
        parsed.result.category = 'PARTIAL_RESPONSE';
      }
      Object.assign(parsed.result.completeness, { dom_matches_source: agree });
    }
    await writeFile(
      resolve(out, 'source-projection.json'),
      JSON.stringify(parsed.sourceProjection, null, 2) + '\n',
      { mode: 0o600 },
    );
    await writeFile(
      resolve(out, 'snapshot.json'),
      JSON.stringify(parsed.snapshot, null, 2) + '\n',
      { mode: 0o600 },
    );
    await writeFile(
      resolve(out, 'transcript.txt'),
      parsed.result.full_text + '\n',
      { mode: 0o600 },
    );
    report = parsed.result;
  } catch (e) {
    const failure =
      e instanceof EngineFailure
        ? e
        : new EngineFailure('TECHNICAL_FAILURE', 'UNEXPECTED_LOCAL_FAILURE');
    report = {
      schema: version,
      video_id: video,
      status: failure.category === 'PARTIAL_RESPONSE' ? 'PARTIAL' : 'REFUSED',
      accepted: false,
      category: failure.category,
      failure_code: failure.code,
      cue_count: 0,
      acquisition:
        mode === 'native'
          ? 'NATIVE_BROWSER'
          : mode === 'publisher'
            ? 'PUBLISHER_CAPTIONS'
            : 'OFFLINE_REPLAY',
    };
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
  const cpuUsed = process.cpuUsage(cpu);
  report.runtime = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    elapsed_ms: Math.round(performance.now() - start),
    node_cpu_ms: (cpuUsed.user + cpuUsed.system) / 1000,
    node_peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
    resource_scope: 'NODE_ONLY_USE_SUPERVISOR_FOR_BROWSER_TREE',
    production_d1_calls: 0,
  };
  await writeFile(
    resolve(out, 'native-diagnostics.json'),
    JSON.stringify(nativeDiagnostics, null, 2) + '\n',
    { mode: 0o600 },
  );
  await writeFile(
    resolve(out, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      schema: version,
      status: report.status,
      category: report.category,
      accepted: report.accepted,
      cue_count: report.cue_count,
      acquisition: report.acquisition,
    }) + '\n',
  );
  // Refusal is an explicit experimental result, not an unhandled process failure.
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((e) => {
    const category =
      e instanceof EngineFailure ? e.category : 'TECHNICAL_FAILURE';
    process.stdout.write(
      JSON.stringify({
        schema: version,
        accepted: false,
        category,
        failure_code:
          e instanceof EngineFailure ? e.code : 'CLI_CONFIGURATION_FAILED',
      }) + '\n',
    );
    process.exitCode = 2;
  });
}
