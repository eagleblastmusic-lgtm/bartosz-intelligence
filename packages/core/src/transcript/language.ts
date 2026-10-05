import type {
  TrackListResult,
  TrackRef,
} from '../../../contracts/src/transcript.js';

export interface ApprovedHelper {
  representation_id: string;
  source_track_id: string;
  source_revision: string;
  mapping_hash: string;
  language_code: 'pl';
}
export type LanguageSelection = Readonly<{
  policy_version: 'original-authority:1';
  status: 'SELECTED' | 'UNKNOWN_AUTHORITY' | 'NO_SOURCE';
  source: TrackRef | null;
  authority_basis:
    'EXPLICIT_ORIGINAL' | 'VIDEO_LANGUAGE' | 'AVAILABLE_ONLY' | null;
  authority_confidence: 'CONFIRMED' | 'LOW' | null;
  helper_track: TrackRef | null;
  approved_helper: ApprovedHelper | null;
  source_revision: string;
}>;
const primary = (language: string) => language.toLowerCase().split('-')[0];
const preference = (track: TrackRef) =>
  track.track_kind === 'MANUAL' ? 0 : track.track_kind === 'GENERATED' ? 1 : 2;

export function selectTranscriptLanguage(
  list: TrackListResult,
  sourceRevision: string,
  helpers: readonly ApprovedHelper[] = [],
): LanguageSelection {
  const base = {
    policy_version: 'original-authority:1' as const,
    source_revision: sourceRevision,
  };
  if (list.status !== 'OK' || !list.tracks.length)
    return Object.freeze({
      ...base,
      status: 'NO_SOURCE',
      source: null,
      authority_basis: null,
      authority_confidence: null,
      helper_track: null,
      approved_helper: null,
    });
  const usable = list.tracks.filter(
    (track) =>
      track.is_translated === false &&
      track.is_generated !== null &&
      ['MANUAL', 'GENERATED'].includes(track.track_kind),
  );
  const explicit = usable.filter((track) => track.is_original === true);
  const language =
    explicit.length &&
    new Set(explicit.map((track) => primary(track.language_code))).size === 1
      ? primary(explicit[0]!.language_code)
      : !explicit.length && list.video_language
        ? primary(list.video_language)
        : null;
  const fallback =
    !explicit.length &&
    !list.video_language &&
    usable.length &&
    usable.every((track) => primary(track.language_code) === 'pl');
  const selectedLanguage = language ?? (fallback ? 'pl' : null);
  const source = selectedLanguage
    ? (usable
        .filter(
          (track) =>
            primary(track.language_code) === selectedLanguage &&
            track.is_original !== false,
        )
        .sort(
          (a, b) =>
            preference(a) - preference(b) ||
            a.track_id.localeCompare(b.track_id),
        )[0] ?? null)
    : null;
  if (!source)
    return Object.freeze({
      ...base,
      status: 'UNKNOWN_AUTHORITY',
      source: null,
      authority_basis: null,
      authority_confidence: null,
      helper_track: null,
      approved_helper: null,
    });
  // Non-translated transport flags do not prove that a manual foreign-language
  // track is native. Such a track requires a separately approved mapping.
  const helper =
    usable
      .filter(
        (track) =>
          primary(track.language_code) === 'pl' &&
          (language === 'pl' || track.is_original === true),
      )
      .sort(
        (a, b) =>
          preference(a) - preference(b) || a.track_id.localeCompare(b.track_id),
      )[0] ?? null;
  const approved =
    helpers.find(
      (value) =>
        value.source_track_id === source.track_id &&
        value.source_revision === sourceRevision &&
        /^[a-f0-9]{64}$/.test(value.mapping_hash),
    ) ?? null;
  return Object.freeze({
    ...base,
    status: 'SELECTED',
    source: Object.freeze({
      ...source,
      translation_languages: [...source.translation_languages],
    }),
    authority_basis: fallback
      ? 'AVAILABLE_ONLY'
      : explicit.length
        ? 'EXPLICIT_ORIGINAL'
        : 'VIDEO_LANGUAGE',
    authority_confidence: fallback ? 'LOW' : 'CONFIRMED',
    helper_track: helper
      ? Object.freeze({
          ...helper,
          translation_languages: [...helper.translation_languages],
        })
      : null,
    approved_helper: approved ? Object.freeze({ ...approved }) : null,
  });
}
