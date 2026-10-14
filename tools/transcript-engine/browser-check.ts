/** Native browser integration on loopback only. No requests to YouTube. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureNative } from './browser.js';
import type { NativeDiagnostics } from './browser.js';
import { analyze, EngineFailure, digest, obj, maxBytes } from './engine.js';
import {
  makeReference,
  makePanel,
  controlSnapshot,
  ids,
  evidencePath,
} from './check.js';

function fixturePage(video: string, scenario: string) {
  const snapshot = controlSnapshot(video);
  const tracks = snapshot.tracks.map((t) => ({
    vssId: t.vss_id,
    languageCode: t.language_code,
    name: { simpleText: t.name },
    baseUrl: `https://www.youtube.com/api/timedtext?v=${video}&lang=en`,
  }));
  const player = {
    videoDetails: { videoId: video },
    playabilityStatus: { status: 'OK' },
    captions: {
      playerCaptionsTracklistRenderer:
        scenario === 'missing-list'
          ? {}
          : { captionTracks: scenario === 'empty-list' ? [] : tracks },
    },
  };
  return `<!doctype html><meta charset="utf-8"><style>
    ytd-engagement-panel-section-list-renderer,ytd-transcript-segment-renderer {display:block}
    .segment-timestamp{display:inline-block;width:80px}.segment-text{display:inline-block;max-width:700px}
    [hidden]{display:none!important}
    </style><div id="movie_player"></div><button>Show transcript</button>
    <ytd-engagement-panel-section-list-renderer target-id="transcript-hidden" hidden>
      <ytd-transcript-segment-renderer><span class="segment-timestamp">0:00</span><span class="segment-text">HIDDEN_COPY_DO_NOT_EXPORT</span></ytd-transcript-segment-renderer>
    </ytd-engagement-panel-section-list-renderer>
    <script>window.ytInitialPlayerResponse=${JSON.stringify(player).replace(/</g, '\\u003c')};
    document.querySelector('#movie_player').getPlayerResponse=()=>window.ytInitialPlayerResponse;
    document.querySelector('button').onclick=async()=>{
      const r=await fetch('/youtubei/v1/get_transcript',{method:'POST'});
      const p=await r.json(); if(p.error)return;
      const s=p.actions[0].updateEngagementPanelAction.content.transcriptRenderer.content.transcriptSearchPanelRenderer.body.transcriptSegmentListRenderer.initialSegments;
      const panel=document.createElement('ytd-engagement-panel-section-list-renderer');
      panel.setAttribute('target-id','engagement-panel-searchable-transcript');
      panel.setAttribute('visibility','ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
      for(const [i,e]of s.entries()){
        const c=e.transcriptSegmentRenderer, row=document.createElement('ytd-transcript-segment-renderer');
        row.setAttribute('aria-posinset',String(i+1));row.setAttribute('aria-setsize',String(s.length));
        const t=document.createElement('span');t.className='segment-timestamp';
        const seconds=Math.floor(Number(c.startMs)/1000);t.textContent=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
        const text=document.createElement('span');text.className='segment-text';text.textContent=c.snippet.runs.map(r=>r.text).join('');
        row.append(t,text);panel.append(row);
      }
      document.body.append(panel);
    };</script>`;
}
export async function browserChecks(
  root: string,
  executable: string,
  out: string,
  noSandbox = false,
  firstOnly = false,
) {
  await mkdir(out, { recursive: true });
  const records: Record<string, unknown>[] = [];
  const cases = [
    ...ids.map((id) => ({ id, scenario: 'real-text-replay' })),
    { id: ids[0]!, scenario: 'repeat-real-text-replay' },
    { id: ids[0]!, scenario: 'prefix' },
    { id: ids[0]!, scenario: 'refused' },
    { id: ids[0]!, scenario: 'empty-list' },
    { id: ids[0]!, scenario: 'missing-list' },
    { id: ids[0]!, scenario: 'invalid-json' },
    { id: ids[0]!, scenario: 'oversized' },
    { id: ids[0]!, scenario: 'cancel' },
    { id: ids[0]!, scenario: 'timeout' },
  ];
  for (const { id, scenario } of firstOnly ? cases.slice(0, 1) : cases) {
    const reference = await makeReference(root, id);
    const panel = JSON.stringify(
      makePanel(
        scenario === 'prefix'
          ? reference.segments.slice(0, -1)
          : reference.segments,
      ),
    );
    let transcriptRequests = 0,
      externalRequests = 0;
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/watch')) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(fixturePage(id, scenario));
        return;
      }
      if (req.url === '/youtubei/v1/get_transcript') {
        transcriptRequests++;
        if (scenario === 'timeout' || scenario === 'cancel') return;
        res.setHeader('content-type', 'application/json');
        if (scenario === 'refused') {
          res.statusCode = 400;
          res.end(
            JSON.stringify({
              error: {
                code: 400,
                status: 'FAILED_PRECONDITION',
                message: 'Precondition check failed.',
              },
            }),
          );
          return;
        }
        if (scenario === 'invalid-json') {
          res.end('{"actions":[');
          return;
        }
        if (scenario === 'oversized') {
          res.end(' '.repeat(maxBytes + 1024));
          return;
        }
        res.end(panel);
        return;
      }
      if (req.url?.startsWith('http')) externalRequests++;
      res.statusCode = 404;
      res.end();
    });
    server.on('connection', (s) => {
      sockets.add(s);
      s.once('close', () => sockets.delete(s));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const controller = new AbortController(),
      d: NativeDiagnostics = {};
    const t0 = performance.now();
    const cancellation =
      scenario === 'cancel'
        ? setTimeout(() => controller.abort(), 500)
        : undefined;
    let category = 'NONE',
      parsed: ReturnType<typeof analyze> | undefined;
    try {
      const capture = await captureNative({
        executable,
        video: id,
        timeoutMs: scenario === 'timeout' ? 2000 : 15000,
        replayOrigin: `http://127.0.0.1:${port}`,
        signal: controller.signal,
        diagnostics: d,
        domReaderPath: fileURLToPath(
          new URL('./dom-reader.js', import.meta.url),
        ),
        allowNoSandbox: noSandbox,
      });
      parsed = analyze({
        video: id,
        format: 'panel',
        body: capture.body,
        snapshot: capture.snapshot,
        reference,
        live: false,
        transportComplete: d.transport_complete === true,
      });
      category = parsed.result.category;
      if (scenario.includes('real-text-replay')) {
        assert.deepEqual(parsed.result.segments, reference.segments);
        const dom = obj(capture.dom),
          rows = dom.segments as { text: string; start: number }[];
        assert.equal(dom.ok, true);
        assert.equal(rows.length, reference.segments.length);
        assert(
          rows.every(
            (r, i) =>
              r.text === reference.segments[i]!.text &&
              r.start === Math.floor(reference.segments[i]!.start_ms! / 1000),
          ),
        );
        assert(!parsed.result.full_text.includes('HIDDEN_COPY'));
        assert.equal(parsed.result.accepted, false);
      }
      if (scenario === 'prefix') {
        assert.equal(parsed.result.status, 'PARTIAL');
        assert.equal(parsed.result.completeness.different_cues, 1);
      }
      await writeFile(
        resolve(out, `${id}-${scenario}.result.json`),
        JSON.stringify(parsed.result, null, 2) + '\n',
      );
      await writeFile(
        resolve(out, `${id}-${scenario}.source-projection.json`),
        JSON.stringify(parsed.sourceProjection, null, 2) + '\n',
      );
    } catch (e) {
      if (!(e instanceof EngineFailure)) throw e;
      category = e.category;
      await writeFile(
        resolve(out, `${id}-${scenario}.failure.json`),
        JSON.stringify(
          { category: e.category, code: e.code, diagnostics: d },
          null,
          2,
        ) + '\n',
      );
      const expected: Record<string, string> = {
        refused: 'SOURCE_REFUSED',
        'empty-list': 'NO_CAPTIONS',
        'missing-list': 'TRACKS_NOT_EXPOSED',
        'invalid-json': 'PARSER_FAILURE',
        oversized: 'TOO_LARGE',
        cancel: 'CANCELLED',
        timeout: 'TIMEOUT',
      };
      assert.equal(
        category,
        expected[scenario],
        `unexpected failure in ${scenario}: ${e.code}`,
      );
    } finally {
      if (cancellation) clearTimeout(cancellation);
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
    const expectedCategories: Record<string, string> = {
      prefix: 'PARTIAL_RESPONSE',
      refused: 'SOURCE_REFUSED',
      'empty-list': 'NO_CAPTIONS',
      'missing-list': 'TRACKS_NOT_EXPOSED',
      'invalid-json': 'PARSER_FAILURE',
      oversized: 'TOO_LARGE',
      cancel: 'CANCELLED',
      timeout: 'TIMEOUT',
    };
    assert.equal(
      category,
      expectedCategories[scenario] ?? 'ORIGINAL_UNCONFIRMED',
    );
    assert(transcriptRequests <= 1);
    assert.equal(externalRequests, 0);
    assert.equal(d.profile_removed, true);
    const record = {
      video_id: id,
      scenario,
      status: 'PASS',
      category,
      accepted: parsed?.result.accepted ?? false,
      cue_count: parsed?.result.cue_count ?? 0,
      cues_sha256: parsed
        ? digest(JSON.stringify(parsed.result.segments))
        : null,
      source_record_sha256: digest(await readFile(evidencePath(root, id))),
      elapsed_ms: Math.round(performance.now() - t0),
      transcript_requests: transcriptRequests,
      external_server_requests: externalRequests,
      diagnostics: d,
    };
    records.push(record);
    await writeFile(
      resolve(out, `${id}-${scenario}.receipt.json`),
      JSON.stringify(record, null, 2) + '\n',
    );
  }
  if (!firstOnly)
    assert.equal(records[0]!.cues_sha256, records[3]!.cues_sha256);
  const result = {
    schema: 'ote-browser-check:1',
    status: 'PASS',
    test_count: records.length,
    platform: process.platform,
    arch: process.arch,
    evidence_level: 'LOOPBACK_REAL_TEXT_REPLAY_RECONSTRUCTED_PANEL_ENVELOPE',
    live_youtube_requests: 0,
    live_caption_acquisitions: 0,
    records,
  };
  await writeFile(
    resolve(out, 'browser.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  return result;
}
if (process.argv[1]?.endsWith('browser-check.mjs')) {
  const [root, executable, out, ...flags] = process.argv.slice(2);
  if (!root || !executable || !out)
    throw new Error('USAGE_ROOT_BROWSER_OUTPUT');
  const result = await browserChecks(
    resolve(root),
    resolve(executable),
    resolve(out),
    flags.includes('--no-sandbox'),
    flags.includes('--first'),
  );
  process.stdout.write(
    JSON.stringify({
      schema: result.schema,
      status: result.status,
      test_count: result.test_count,
      platform: result.platform,
      arch: result.arch,
      live_youtube_requests: 0,
    }) + '\n',
  );
}
