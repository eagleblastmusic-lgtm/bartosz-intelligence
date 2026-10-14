/** Portable regression suite. Real recorded texts; artificial envelopes are explicit controls. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  analyze,
  EngineFailure,
  digest,
  runSourcePlan,
  listingFailure,
  snapshotProjection,
  maxBytes,
} from './engine.js';
import type { Input, Category } from './engine.js';
import { decodeOffline, publicVideoId } from '../probes/source-probe.js';

export const ids = ['aircAruvnKk', 'IHZwWFHWa-w', 'LPZh9BOjkQs'];
export const evidencePath = (root: string, id: string) =>
  resolve(
    root,
    `tools/firefox-transcript-diagnostic-2026-10-12/evidence/${id}.reference.json`,
  );
export function makePanel(
  cues: { start_ms: number | null; end_ms: number | null; text: string }[],
  title = 'English',
) {
  return {
    actions: [
      {
        updateEngagementPanelAction: {
          content: {
            transcriptRenderer: {
              content: {
                transcriptSearchPanelRenderer: {
                  body: {
                    transcriptSegmentListRenderer: {
                      initialSegments: cues.map((c) => ({
                        transcriptSegmentRenderer: {
                          startMs: String(c.start_ms),
                          endMs: String(c.end_ms),
                          snippet: { runs: [{ text: c.text }] },
                        },
                      })),
                    },
                  },
                  footer: {
                    transcriptFooterRenderer: {
                      languageMenu: {
                        sortFilterSubMenuRenderer: {
                          subMenuItems: [
                            {
                              title,
                              selected: true,
                              continuation: {
                                reloadContinuationData: {
                                  continuation: 'DO_NOT_SAVE_TEST_TOKEN',
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
  };
}
export const controlSnapshot = (video: string) => ({
  video_id: video,
  playability_status: 'OK',
  tracks_explicit: true,
  original_language: null,
  tracks: [
    {
      vss_id: '.en',
      language_code: 'en',
      kind: 'MANUAL',
      name: 'English',
      is_translated: false,
    },
  ],
});
export async function makeReference(root: string, id: string) {
  const body = await readFile(evidencePath(root, id), 'utf8');
  return {
    schema: 'ote-reference:1',
    video_id: id,
    language_code: 'en',
    track_kind: 'UNKNOWN',
    vss_id: null,
    independent: false,
    complete: false,
    original: false,
    provenance:
      'Historical Windows youtube-transcript-api record; independence and original authority NOT established',
    raw_sha256: digest(body),
    segments: decodeOffline('recorded-en', body),
  };
}
export async function checks(root: string) {
  const tests: string[] = [];
  const test = async (name: string, run: () => void | Promise<void>) => {
    await run();
    tests.push(name);
  };
  const reference = await makeReference(root, ids[0]!);
  const input: Input = {
    video: ids[0]!,
    format: 'panel',
    body: JSON.stringify(makePanel(reference.segments)),
    snapshot: controlSnapshot(ids[0]!),
    reference,
    live: false,
    transportComplete: true,
  };
  const expect = (f: () => unknown, category: Category) =>
    assert.throws(
      f,
      (e: unknown) => e instanceof EngineFailure && e.category === category,
    );
  await test('all real recorded cue texts and boundaries survive panel projection', () => {
    const { result, sourceProjection } = analyze(input);
    assert.deepEqual(result.segments, reference.segments);
    assert.equal(result.accepted, false);
    assert.equal(result.completeness.independently_confirmed_complete, false);
    assert.equal(result.cue_count, 286);
    assert.equal(result.first_start_ms, 4220);
    assert.equal(result.last_end_ms, 1105640);
    assert(
      !JSON.stringify(sourceProjection).includes('DO_NOT_SAVE_TEST_TOKEN'),
    );
  });
  await test('valid prefix cannot be accepted or match full available reference', () => {
    const r = analyze({
      ...input,
      body: JSON.stringify(makePanel(reference.segments.slice(0, -1))),
    }).result;
    assert.equal(r.status, 'PARTIAL');
    assert.equal(r.accepted, false);
    assert.equal(r.completeness.different_cues, 1);
  });
  await test('missing middle cue cannot be hidden by last timestamp', () => {
    const r = analyze({
      ...input,
      body: JSON.stringify(
        makePanel(reference.segments.filter((_, i) => i !== 120)),
      ),
    }).result;
    assert.equal(r.category, 'PARTIAL_RESPONSE');
    assert.equal(r.accepted, false);
  });
  await test('wrong reference video is not comparison success', () =>
    expect(
      () =>
        analyze({ ...input, reference: { ...reference, video_id: ids[1] } }),
      'IDENTITY_MISMATCH',
    ));
  await test('stale player video is refused', () =>
    expect(
      () => analyze({ ...input, snapshot: controlSnapshot(ids[1]!) }),
      'IDENTITY_MISMATCH',
    ));
  await test('missing endMs is not reconstructed from next start', () => {
    const p = JSON.stringify(
      makePanel([{ ...reference.segments[0]!, end_ms: null }]),
    );
    expect(() => analyze({ ...input, body: p }), 'PARTIAL_RESPONSE');
  });
  await test('unconsumed list continuation is partial; language token is not pagination', () => {
    const p = makePanel(reference.segments);
    Object.assign(
      p.actions[0]!.updateEngagementPanelAction.content.transcriptRenderer
        .content.transcriptSearchPanelRenderer.body
        .transcriptSegmentListRenderer,
      {
        continuations: [
          { nextContinuationData: { continuation: 'not-fetched' } },
        ],
      },
    );
    expect(
      () => analyze({ ...input, body: JSON.stringify(p) }),
      'PARTIAL_RESPONSE',
    );
  });
  await test('unknown source-bearing renderer is not silently dropped', () => {
    const p = JSON.stringify(makePanel(reference.segments)).replace(
      'transcriptSegmentRenderer',
      'newTranscriptRowViewModel',
    );
    expect(() => analyze({ ...input, body: p }), 'UPSTREAM_CHANGED');
  });
  await test('incomplete transport is different from invalid JSON', () => {
    expect(
      () => analyze({ ...input, transportComplete: false }),
      'PARTIAL_RESPONSE',
    );
    expect(() => analyze({ ...input, body: '{"actions":[' }), 'PARSER_FAILURE');
  });
  await test('source FAILED_PRECONDITION is access refusal, before cue parser', () =>
    expect(
      () =>
        analyze({
          ...input,
          body: JSON.stringify({
            error: {
              code: 400,
              status: 'FAILED_PRECONDITION',
              message: 'do not persist',
            },
          }),
        }),
      'SOURCE_REFUSED',
    ));
  await test('empty 200 cannot become NO_CAPTIONS', () =>
    expect(() => analyze({ ...input, body: '' }), 'EMPTY_RESPONSE'));
  await test('absent listing differs from explicit empty playable listing', () => {
    const absent = snapshotProjection(
      { ...controlSnapshot(ids[0]!), tracks_explicit: false, tracks: [] },
      ids[0]!,
    );
    const empty = snapshotProjection(
      { ...controlSnapshot(ids[0]!), tracks: [] },
      ids[0]!,
    );
    assert.equal(listingFailure(absent)?.category, 'TRACKS_NOT_EXPOSED');
    assert.equal(listingFailure(empty)?.category, 'NO_CAPTIONS');
  });
  await test('body limit is enforced', () =>
    expect(
      () => analyze({ ...input, body: ' '.repeat(maxBytes + 1) }),
      'TOO_LARGE',
    ));
  await test('overlapping repeated cue text is preserved exactly', () => {
    const cues = [
      { start_ms: 4220, end_ms: 5400, text: ' repeat\n' },
      { start_ms: 5000, end_ms: 6000, text: ' repeat\n' },
    ];
    const r = analyze({
      ...input,
      body: JSON.stringify(makePanel(cues)),
      reference: undefined,
    }).result;
    assert.equal(r.cue_count, 2);
    assert.equal(r.segments[1]!.text, ' repeat\n');
    assert.equal(r.segments[1]!.start_ms, 5000);
  });
  await test('GENERATED identity preserves rolling overlaps and repetitions', () => {
    const s = controlSnapshot(ids[0]!);
    s.tracks[0] = { ...s.tracks[0]!, kind: 'GENERATED', vss_id: 'a.en' };
    const cues = [
      { start_ms: 1000, end_ms: 3000, text: 'same' },
      { start_ms: 2000, end_ms: 4000, text: 'same' },
    ];
    const r = analyze({
      ...input,
      body: JSON.stringify(makePanel(cues)),
      snapshot: s,
      reference: undefined,
    }).result;
    assert.equal(r.track_kind, 'GENERATED');
    assert.equal(r.is_generated, true);
    assert.equal(r.cue_count, 2);
    assert.equal(r.segments[1]!.start_ms, 2000);
    assert.equal(r.accepted, false);
  });
  await test('existing JSON3 decoder retains all text and original control-event indices', () => {
    const body = JSON.stringify({
      events: [
        { tStartMs: 0 },
        { tStartMs: 10, dDurationMs: 20, segs: [{ utf8: ' x\n' }] },
        { tStartMs: 20, dDurationMs: 30, segs: [{ utf8: ' x\n' }] },
      ],
    });
    const r = analyze({
      ...input,
      format: 'json3',
      body,
      reference: undefined,
    }).result;
    assert.equal(r.cue_count, 2);
    assert.deepEqual(r.provenance.original_indices, [1, 2]);
    assert.equal(r.segments[0]!.end_ms, 30);
    assert.equal(r.segments[1]!.text, ' x\n');
    expect(
      () =>
        analyze({
          ...input,
          format: 'json3',
          body: JSON.stringify({
            events: [{ tStartMs: 10, segs: [{ utf8: 'source text' }] }],
          }),
          reference: undefined,
        }),
      'PARTIAL_RESPONSE',
    );
  });
  await test('same label on two tracks has unknown identity', () => {
    const s = controlSnapshot(ids[0]!);
    s.tracks.push({ ...s.tracks[0]!, vss_id: 'a.en', kind: 'GENERATED' });
    const r = analyze({ ...input, snapshot: s }).result;
    assert.equal(r.vss_id, null);
    assert.equal(r.accepted, false);
  });
  await test('wrong selected track and wrong reference language are refused', () => {
    expect(
      () => analyze({ ...input, expectedTrackId: 'a.en' }),
      'IDENTITY_MISMATCH',
    );
    expect(
      () =>
        analyze({ ...input, reference: { ...reference, language_code: 'pl' } }),
      'IDENTITY_MISMATCH',
    );
  });
  await test('default original claim and same-source reference do not prove full transcript', () => {
    const r = analyze({
      ...input,
      snapshot: { ...controlSnapshot(ids[0]!), original_language: 'en' },
      live: true,
    }).result;
    assert.equal(r.accepted, false);
    assert.equal(r.category, 'COMPLETENESS_UNCONFIRMED');
  });
  await test('offline cannot be promoted to live acquisition even by reference declarations', () => {
    const r = analyze({
      ...input,
      reference: {
        ...reference,
        independent: true,
        complete: true,
        original: true,
        vss_id: '.en',
        track_kind: 'MANUAL',
      },
    }).result;
    assert.equal(r.accepted, false);
    assert.equal(r.acquisition, 'OFFLINE_REPLAY');
  });
  await test('retained PL DOM has no fabricated ends or original identity', async () => {
    const body = await readFile(
      resolve(
        root,
        'tools/firefox-transcript-v0.4.2/evidence/bartosz-transcript-aircAruvnKk.json',
      ),
      'utf8',
    );
    const r = analyze({
      ...input,
      format: 'recorded-dom',
      body,
      reference: undefined,
      snapshot: {
        ...controlSnapshot(ids[0]!),
        tracks: [
          {
            vss_id: null,
            language_code: 'pl',
            kind: 'UNKNOWN',
            name: 'Polski — diagnostic DOM',
            is_translated: null,
          },
        ],
      },
    }).result;
    assert.equal(r.cue_count, 223);
    assert.equal(r.last_end_ms, null);
    assert.equal(r.category, 'PARTIAL_RESPONSE');
  });
  await test('strict public URL identity', () => {
    assert.equal(publicVideoId('https://youtu.be/aircAruvnKk'), ids[0]);
    assert.throws(() =>
      publicVideoId('https://example.com/watch?v=aircAruvnKk'),
    );
    assert.throws(() =>
      publicVideoId(
        'https://www.youtube.com/watch?v=aircAruvnKk&v=IHZwWFHWa-w',
      ),
    );
  });
  await test('methods of one upstream cannot masquerade as independent sources', async () => {
    let requests = 0;
    await assert.rejects(() =>
      runSourcePlan<{ category: Category; accepted: boolean }>([
        {
          domain: 'youtube',
          run: async () => {
            requests++;
            return { category: 'SOURCE_REFUSED' as const, accepted: false };
          },
        },
        {
          domain: 'youtube',
          run: async () => {
            requests++;
            return { category: 'NONE' as const, accepted: true };
          },
        },
      ]),
    );
    assert.equal(requests, 0);
  });
  await test('refusal is terminal without retry or fallback', async () => {
    let requests = 0;
    const results = await runSourcePlan<{
      category: Category;
      accepted: boolean;
    }>([
      {
        domain: 'youtube',
        run: async () => {
          requests++;
          return { category: 'SOURCE_REFUSED' as const, accepted: false };
        },
      },
      {
        domain: 'independent-author-file',
        run: async () => {
          requests++;
          return { category: 'NONE' as const, accepted: true };
        },
      },
    ]);
    assert.equal(requests, 1);
    assert.equal(results.length, 1);
  });
  const records = [];
  for (const id of ids) {
    const ref = await makeReference(root, id),
      raw = await readFile(evidencePath(root, id), 'utf8');
    const r = analyze({
      ...input,
      video: id,
      format: 'recorded-en',
      body: raw,
      reference: ref,
      snapshot: {
        ...controlSnapshot(id),
        tracks: [
          { ...controlSnapshot(id).tracks[0]!, vss_id: null, kind: 'UNKNOWN' },
        ],
      },
    }).result;
    assert.deepEqual(r.segments, ref.segments);
    records.push({
      video_id: id,
      raw_sha256: digest(raw),
      cues_sha256: digest(JSON.stringify(r.segments)),
      cue_count: r.cue_count,
      first_start_ms: r.first_start_ms,
      last_end_ms: r.last_end_ms,
      full_timing: r.completeness.full_timing,
      reference_matches: r.completeness.reference_matches,
      accepted: r.accepted,
    });
  }
  return {
    schema: 'ote-check:1',
    status: 'PASS',
    test_count: tests.length,
    tests,
    records,
    evidence_level: 'OFFLINE_REAL_TEXT_REPLAY_AND_SYNTHETIC_ENVELOPES',
    live_caption_acquisitions: 0,
  };
}
if (process.argv[1]?.endsWith('engine-check.mjs')) {
  const root = resolve(process.argv[2] ?? '.'),
    out = process.argv[3];
  const result = await checks(root);
  if (out) {
    await mkdir(resolve(out), { recursive: true });
    await writeFile(
      resolve(out, 'portable.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}
