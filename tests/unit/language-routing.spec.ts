import { describe, expect, it } from 'vitest';
import { selectTranscriptLanguage } from '../../packages/core/src/transcript/language.js';
import type {
  TrackRef,
  TrackListResult,
} from '../../packages/contracts/src/transcript.js';
const track = (
  language: string,
  changes: Partial<TrackRef> = {},
): TrackRef => ({
  track_id: language,
  item_id: 'item',
  language_code: language,
  track_kind: 'MANUAL',
  is_generated: false,
  is_translated: false,
  source_language: null,
  translation_source_track_id: null,
  is_translatable: null,
  translation_languages: [],
  is_original: null,
  extension: 'json3',
  expires_at: '2026-10-06T01:00:00Z',
  ...changes,
});
const list = (
  tracks: TrackRef[],
  video_language: string | null = null,
): TrackListResult => ({
  status: 'OK',
  failure_code: null,
  provider_id: 'local_ytdlp',
  provider_version: 'pinned',
  runtime_id: 'local',
  tracks,
  video_language,
  retrieved_at: '2026-10-06T00:00:00Z',
  request_id: 'r',
});
describe('original-language authority', () => {
  it('preserves English source and does not promote unknown Polish provenance', () => {
    const selected = selectTranscriptLanguage(
      list([
        track('pl'),
        track('en'),
        track('en', {
          track_id: 'en-asr',
          track_kind: 'GENERATED',
          is_generated: true,
          is_original: true,
        }),
      ]),
      'revision',
    );
    expect(selected.source?.track_id).toBe('en');
    expect(selected.authority_basis).toBe('EXPLICIT_ORIGINAL');
    expect(selected.helper_track).toBeNull();
    expect(selected.status).toBe('SELECTED');
  });
  it('selects Polish manual before generated when actual audio language is Polish', () => {
    const selected = selectTranscriptLanguage(
      list(
        [
          track('pl', {
            track_id: 'asr',
            track_kind: 'GENERATED',
            is_generated: true,
          }),
          track('pl'),
        ],
        'pl-PL',
      ),
      'revision',
    );
    expect(selected.source?.track_id).toBe('pl');
    expect(selected.helper_track?.track_id).toBe('pl');
  });
  it('keeps unknown and conflicting original languages unresolved', () => {
    const onlyPolish = selectTranscriptLanguage(list([track('pl')]), 'r');
    expect(onlyPolish.source?.language_code).toBe('pl');
    expect(onlyPolish.authority_basis).toBe('AVAILABLE_ONLY');
    expect(onlyPolish.authority_confidence).toBe('LOW');
    expect(onlyPolish.helper_track).toBeNull();
    expect(selectTranscriptLanguage(list([track('en')]), 'r').status).toBe(
      'UNKNOWN_AUTHORITY',
    );
    expect(
      selectTranscriptLanguage(
        list(
          [
            track('en', { is_original: true }),
            track('pl', { is_original: true }),
          ],
          'en',
        ),
        'r',
      ).status,
    ).toBe('UNKNOWN_AUTHORITY');
    expect(
      selectTranscriptLanguage(
        list(
          [
            track('pl', {
              is_translated: true,
              track_kind: 'TRANSLATED',
              source_language: 'en',
            }),
          ],
          'en',
        ),
        'r',
      ).source,
    ).toBeNull();
  });
  it('requires approved helpers bound to the exact source revision and snapshots values', () => {
    const helper = {
      representation_id: 'helper',
      source_track_id: 'en',
      source_revision: 'r1',
      mapping_hash: 'a'.repeat(64),
      language_code: 'pl' as const,
    };
    const tracks = list([track('en')], 'en');
    const old = selectTranscriptLanguage(tracks, 'r1', [helper]);
    helper.representation_id = 'replacement';
    tracks.tracks[0]!.language_code = 'pl';
    expect(old.approved_helper?.representation_id).toBe('helper');
    expect(old.source?.language_code).toBe('en');
    expect(
      selectTranscriptLanguage(list([track('en')], 'en'), 'r2', [helper])
        .approved_helper,
    ).toBeNull();
  });
});
