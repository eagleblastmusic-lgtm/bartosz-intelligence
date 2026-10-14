import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  decodeOffline,
  httpCategory,
  liveProbe,
  matchesReference,
  offlineProbe,
  publicVideoId,
  validateSegments,
} from '../../tools/probes/source-probe.js';
const fixture = (name: string) =>
  readFileSync('tests/fixtures/source-probe/' + name, 'utf8');
const input = {
  video: 'aircAruvnKk',
  operation: 'offline',
  format: 'panel-segments',
} as const;
it('accepts supported public inputs and rejects credentials, arbitrary hosts and ambiguous IDs', () => {
  for (const value of [
    'aircAruvnKk',
    'https://youtu.be/aircAruvnKk',
    'https://www.youtube.com/watch?v=aircAruvnKk',
    'https://youtube.com/shorts/aircAruvnKk',
  ])
    expect(publicVideoId(value)).toBe('aircAruvnKk');
  for (const value of [
    'https://youtube.com.evil.invalid/watch?v=aircAruvnKk',
    'https://secret@youtube.com/watch?v=aircAruvnKk',
    'https://youtube.com/watch?v=aircAruvnKk&v=IHZwWFHWa-w',
    'https://youtube.com:8443/watch?v=aircAruvnKk',
  ])
    expect(() => publicVideoId(value)).toThrow('INVALID_INPUT');
});
it('retains fractional panel times, repeated utterances and all text across formats', async () => {
  const source = fixture('panel-segments.json'),
    expected = decodeOffline('srt', fixture('same-cues.srt'));
  for (const [format, name] of [
    ['panel-segments', 'panel-segments.json'],
    ['supadata-native', 'native-api.json'],
    ['json3', 'same-cues.json3'],
  ] as const)
    expect(
      matchesReference(decodeOffline(format, fixture(name)), expected),
    ).toBe(true);
  const result = await offlineProbe(input, source, {
    format: 'srt',
    body: fixture('same-cues.srt'),
  });
  expect(result).toMatchObject({
    segment_count: 2,
    first_start_ms: 4220,
    last_end_ms: 10713,
    validation: {
      full_timing: true,
      repeated_text_count: 1,
      coverage_count: 2,
    },
    levels: {
      STRUCTURALLY_VALID: true,
      MATCHES_AVAILABLE_REFERENCE: true,
      INDEPENDENTLY_CONFIRMED_COMPLETE: false,
    },
    original_language_confirmed: false,
    caption_accepted: false,
  });
});
it('does not invent DOM ends or language authority', async () => {
  const body = JSON.stringify({
    videoId: 'aircAruvnKk',
    language: 'pl - unknown',
    segments: [{ index: 0, timestamp: '0:04', text: 'fixture' }],
  });
  const result = await offlineProbe({ ...input, format: 'recorded-dom' }, body);
  expect(result).toMatchObject({
    category: 'NONE',
    first_start_ms: 4000,
    last_end_ms: null,
    language: null,
    track_kind: 'UNKNOWN',
    validation: { full_timing: false, gap_count: null, largest_gap_ms: null },
    levels: {
      STRUCTURALLY_VALID: true,
      INDEPENDENTLY_CONFIRMED_COMPLETE: false,
    },
  });
});
it('rejects valid prefixes against the available whole reference and invalid final cues', async () => {
  const body = JSON.parse(fixture('panel-segments.json'));
  body.segments.pop();
  const partial = await offlineProbe(input, JSON.stringify(body), {
    body: fixture('same-cues.srt'),
    format: 'srt',
  });
  expect(partial).toMatchObject({
    category: 'PARTIAL_RESPONSE',
    caption_accepted: false,
    levels: { STRUCTURALLY_VALID: true, MATCHES_AVAILABLE_REFERENCE: false },
  });
  body.segments.push({
    startMs: '7000',
    snippet: { simpleText: 'missing end' },
  });
  expect((await offlineProbe(input, JSON.stringify(body))).category).toBe(
    'PARTIAL_RESPONSE',
  );
});
it('rejects a reference tagged with another video and an unsupported reference format', async () => {
  const reference = JSON.parse(fixture('panel-segments.json'));
  reference.video_id = 'IHZwWFHWa-w';
  const result = await offlineProbe(input, fixture('panel-segments.json'), {
    format: 'panel-segments',
    body: JSON.stringify(reference),
  });
  expect(result).toMatchObject({
    category: 'INVALID_INPUT',
    levels: { STRUCTURALLY_VALID: true, MATCHES_AVAILABLE_REFERENCE: null },
    caption_accepted: false,
  });
  const unknown = await offlineProbe(input, fixture('panel-segments.json'), {
    format: 'unrecognized' as 'panel-segments',
    body: fixture('native-api.json'),
  });
  expect(unknown.category).toBe('INVALID_INPUT');
  expect(unknown.levels.MATCHES_AVAILABLE_REFERENCE).toBeNull();
});
it('rejects wrong video, duplicate indexes, out-of-order starts and negative durations', async () => {
  const cues = decodeOffline('panel-segments', fixture('panel-segments.json'));
  await expect(
    validateSegments(
      [cues[0]!, { ...cues[1]!, upstream_index: 0 }],
      '0'.repeat(64),
    ),
  ).rejects.toThrow();
  await expect(
    validateSegments([cues[0]!, { ...cues[1]!, start_ms: 1 }], '0'.repeat(64)),
  ).rejects.toThrow();
  expect(
    (
      await offlineProbe(
        { ...input, format: 'recorded-en' },
        '{"video_id":"IHZwWFHWa-w","segments":[{"start":0,"duration":1,"text":"fixture"}]}',
      )
    ).category,
  ).toBe('INVALID_INPUT');
  expect(() =>
    decodeOffline(
      'supadata-native',
      '{"content":[{"offset":0,"duration":-1,"text":"fixture"}]}',
    ),
  ).toThrow();
});
it('classifies denials without guessing an IP cause or parser failure and never retries', async () => {
  for (const status of [403, 429, 500]) {
    const transport = vi.fn(
      async () => new Response('private-cookie-and-signed-url', { status }),
    ) as unknown as typeof fetch;
    const result = await liveProbe(
      { video: input.video, operation: 'oembed' },
      { fetch: transport },
    );
    expect(result.category).toBe(httpCategory(status, null));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(
      'private-cookie-and-signed-url',
    );
    expect(result.request_count).toBe(1);
  }
  expect(httpCategory(206, 'transcript-unavailable')).toBe('NO_CAPTIONS');
  expect(httpCategory(206, null)).toBe('PARTIAL_RESPONSE');
});
it('distinguishes empty HTTP 200, invalid JSON, metadata success and absent caption evidence', async () => {
  for (const [body, wanted] of [
    ['', 'EMPTY_RESPONSE'],
    ['{', 'PARSER_FAILURE'],
    [
      JSON.stringify({
        type: 'video',
        provider_name: 'YouTube',
        title: 'fixture',
        author_name: 'fixture',
        html: 'SECRET_IFRAME_QUERY',
        cookie: 'SECRET_COOKIE',
      }),
      'NONE',
    ],
  ]) {
    const result = await liveProbe(
      { video: input.video, operation: 'oembed' },
      { fetch: (async () => new Response(body)) as typeof fetch },
    );
    expect(result.category).toBe(wanted);
    expect(result.caption_track_found).toBeNull();
    expect(result.caption_accepted).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/SECRET_/);
  }
});
it('requires a separate access basis, key and confirmed Free plan before any native request', async () => {
  const transport = vi.fn() as unknown as typeof fetch;
  const live = { video: input.video, operation: 'supadata-native' } as const;
  expect((await liveProbe(live, { fetch: transport })).category).toBe(
    'NO_AUTHORIZED_ACCESS',
  );
  expect(
    (
      await liveProbe(
        {
          ...live,
          access: { confirmed: true, method: 'fixture', content: 'fixture' },
        },
        { fetch: transport },
      )
    ).category,
  ).toBe('BLOCKED_INPUT');
  expect(transport).not.toHaveBeenCalled();
});
it('forces native structured mode, keeps the diagnostic key out of evidence and rejects original authority', async () => {
  const transport = vi.fn(async () => new Response(fixture('native-api.json')));
  const result = await liveProbe(
    {
      video: input.video,
      operation: 'supadata-native',
      access: {
        confirmed: true,
        method: 'fixture',
        content: 'fixture',
        free_plan_confirmed: true,
      },
    },
    { key: 'EXPERIMENT_KEY', fetch: transport as typeof fetch },
  );
  const [url, options] = transport.mock.calls[0] as unknown as [
    URL,
    RequestInit,
  ];
  expect(url.searchParams.get('mode')).toBe('native');
  expect(url.searchParams.get('text')).toBe('false');
  expect(options.redirect).toBe('manual');
  expect(result).toMatchObject({
    segment_count: 2,
    language: 'en',
    track_kind: 'UNKNOWN',
    caption_accepted: false,
    original_language_confirmed: false,
  });
  expect(JSON.stringify(result)).not.toContain('EXPERIMENT_KEY');
});
it('aborts pending transport without another attempt and does not start an already cancelled probe', async () => {
  const controller = new AbortController();
  const transport = vi.fn(
    (_url: unknown, options?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        options!.signal!.addEventListener(
          'abort',
          () => reject(new Error('PRIVATE_FAILURE')),
          { once: true },
        ),
      ),
  );
  const pending = liveProbe(
    { video: input.video, operation: 'oembed' },
    { fetch: transport as typeof fetch, signal: controller.signal },
  );
  controller.abort();
  expect((await pending).category).toBe('CANCELLED');
  expect(transport).toHaveBeenCalledTimes(1);
  const cancelled = await liveProbe(
    { video: input.video, operation: 'oembed' },
    { fetch: transport as typeof fetch, signal: controller.signal },
  );
  expect(cancelled.request_count).toBe(0);
});
