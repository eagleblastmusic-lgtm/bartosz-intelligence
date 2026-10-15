"""Adapter regressions with real track/parser helpers and no source requests."""
import argparse
import importlib.util
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    'oracle_caption_diagnostic', ROOT / 'tools/transcript-engine/login-diagnostic.py'
)
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)


def formats(language, *, generated=False, translated=None):
    url = f'https://www.youtube.com/api/timedtext?v=fixture0001&lang={language}'
    if generated:
        url += '&kind=asr'
    if translated:
        url += '&tlang=' + translated
    return [{'ext': 'json3', 'url': url}]


class OracleCaptionSelectionTests(unittest.TestCase):
    def run_adapter(self, info, item_id='00000000-0000-4000-8000-000000000001', default_audio_language=None):
        opened = []
        payload = json.dumps({'events': [
            {'tStartMs': 250, 'dDurationMs': 3250, 'segs': [{'utf8': '  Exact source.  '}]},
            {'tStartMs': 3500, 'dDurationMs': 1000, 'segs': [{'utf8': 'Again.'}]},
        ]}).encode()

        class Session:
            def request(self, *args, **kwargs):
                raise AssertionError('No requests transport may run in this fixture')

            def close(self):
                pass

        class YDL:
            def __init__(self, options):
                if 'cookiefile' in options:
                    raise AssertionError('No session file is used by this fixture')

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def extract_info(self, *args, **kwargs):
                return info

            def urlopen(self, request):
                opened.append(request)
                response = io.BytesIO(payload)
                response.url = request
                response.status = 200
                return response

        class HTTPError(Exception):
            pass

        fake_modules = {
            'requests': types.SimpleNamespace(Session=Session),
            'yt_dlp': types.SimpleNamespace(YoutubeDL=YDL),
            'yt_dlp.networking.exceptions': types.SimpleNamespace(HTTPError=HTTPError),
        }
        args = argparse.Namespace(
            mode='ytdlp', video='fixture0001', client='mweb',
            cookies=None, persistent_session=False, pot_player=False,
            adapter=True, max_requests=8, output=ROOT / 'offline-selection-fixture',
            parser=ROOT / 'apps/executor/python/transcript_ytdlp.py',
            item_id=item_id,
            default_audio_language=default_audio_language,
        )
        result = {'players': [], 'requests': []}
        artifacts = {}

        def save_bytes(path, body):
            artifacts[path.name] = body
            return len(body)

        with patch.dict(sys.modules, fake_modules), patch.object(
            diagnostic.importlib.metadata, 'version', return_value='2026.8.19'
        ), patch.object(Path, 'write_bytes', autospec=True, side_effect=save_bytes), patch.object(
            Path, 'write_text', autospec=True, side_effect=lambda path, text, **kwargs: len(text)
        ):
            diagnostic.run(args, result)
        if result.get('cue_count'):
            result['saved_cues'] = json.loads(artifacts['segments.json'])
        return result, opened

    def test_explicit_original_language_prefers_manual_regional_track(self):
        result, opened = self.run_adapter({
            'language': 'fr',
            'subtitles': {'fr': formats('fr'), 'en-GB': formats('en-GB')},
            'automatic_captions': {'en-orig': formats('en', generated=True)},
        })
        self.assertEqual(result['status'], 'CAPTIONS_RECEIVED')
        self.assertEqual(result['provider_selected']['track_kind'], 'MANUAL')
        self.assertEqual(result['provider_selected']['language_code'], 'en-GB')
        self.assertEqual(len(opened), 1)
        self.assertIn('lang=en-GB', opened[0])
        self.assertEqual(result['saved_cues'][0]['text'], '  Exact source.  ')
        self.assertEqual(result['saved_cues'][0]['end_ms'], 3500)

    def test_generated_original_track_is_used_when_manual_original_is_absent(self):
        result, opened = self.run_adapter({
            'language': 'en',
            'subtitles': {'pl': formats('pl')},
            'automatic_captions': {'en-orig': formats('en', generated=True)},
        })
        self.assertEqual(result['status'], 'CAPTIONS_RECEIVED')
        self.assertEqual(result['provider_selected']['track_kind'], 'GENERATED')
        self.assertTrue(result['provider_selected']['is_original'])
        self.assertFalse(result['provider_selected']['is_translated'])
        self.assertEqual(len(opened), 1)
        self.assertIn('kind=asr', opened[0])

    def test_multiple_manual_original_tracks_use_the_executor_item_hash_tie(self):
        result, opened = self.run_adapter({
            'language': 'en',
            'subtitles': {'en': formats('en'), 'en-GB': formats('en-GB')},
        }, item_id='00000000-0000-4000-8000-000000000001')
        self.assertEqual(result['status'], 'CAPTIONS_RECEIVED')
        self.assertEqual(result['provider_selected']['track_kind'], 'MANUAL')
        self.assertEqual(result['provider_selected']['language_code'], 'en-GB')
        self.assertEqual(len(opened), 1)
        self.assertIn('lang=en-GB', opened[0])

    def test_translation_or_conflicting_original_languages_never_trigger_fetch(self):
        cases = [
            {'language': 'en', 'automatic_captions': {
                'en': formats('fr', generated=True, translated='en'),
            }},
            {'language': 'en', 'automatic_captions': {
                'en-orig': formats('en', generated=True),
                'fr-orig': formats('fr', generated=True),
            }},
        ]
        for info in cases:
            with self.subTest(info=info):
                result, opened = self.run_adapter(info)
                self.assertEqual(result['status'], 'UNKNOWN_SOURCE_AUTHORITY')
                self.assertEqual(opened, [])
                self.assertNotIn('provider_selected', result)

    def test_verified_audio_language_selects_manual_source_when_provider_language_is_missing(self):
        result, opened = self.run_adapter({
            'language': None,
            'subtitles': {'en': formats('en'), 'fr': formats('fr')},
            'automatic_captions': {'en': formats('en', generated=True)},
        }, default_audio_language='en')
        self.assertEqual(result['status'], 'CAPTIONS_RECEIVED')
        self.assertEqual(result['video_language'], 'en')
        self.assertEqual(result['video_language_provenance'], 'youtube.videos.snippet.defaultAudioLanguage')
        self.assertEqual(result['provider_selected']['track_kind'], 'MANUAL')
        self.assertEqual(result['provider_selected']['language_code'], 'en')
        self.assertEqual(len(opened), 1)
        self.assertEqual(result['saved_cues'][0], {
            'upstream_index': 0, 'start_ms': 250, 'end_ms': 3500,
            'text': '  Exact source.  ', 'speaker_label': None,
        })

    def test_verified_audio_language_can_select_original_generated_without_alias(self):
        result, opened = self.run_adapter({
            'subtitles': {'fr': formats('fr')},
            'automatic_captions': {'de': formats('de', generated=True)},
        }, default_audio_language='de-DE')
        self.assertEqual(result['status'], 'CAPTIONS_RECEIVED')
        self.assertEqual(result['provider_selected']['track_kind'], 'GENERATED')
        self.assertEqual(result['provider_selected']['language_code'], 'de')
        self.assertFalse(result['provider_selected']['is_translated'])
        self.assertEqual(len(opened), 1)

    def test_verified_audio_language_never_overrides_provider_language_or_explicit_original(self):
        for info in [
            {'language': 'fr', 'subtitles': {'en': formats('en'), 'fr': formats('fr')}},
            {'language': None, 'subtitles': {'en': formats('en'), 'fr': formats('fr')},
             'automatic_captions': {'fr-orig': formats('fr', generated=True)}},
        ]:
            result, opened = self.run_adapter(info, default_audio_language='en')
            self.assertEqual(result['status'], 'CAPTIONS_RECEIVED')
            self.assertEqual(result['provider_selected']['language_code'], 'fr')
            self.assertEqual(len(opened), 1)

    def test_verified_audio_language_does_not_resolve_conflicting_originals_or_translations(self):
        for info in [
            {'automatic_captions': {'en-orig': formats('en', generated=True),
                                     'fr-orig': formats('fr', generated=True)}},
            {'automatic_captions': {'en': formats('fr', generated=True, translated='en')}},
        ]:
            result, opened = self.run_adapter(info, default_audio_language='en')
            self.assertEqual(result['status'], 'UNKNOWN_SOURCE_AUTHORITY')
            self.assertEqual(opened, [])

    def test_absent_audio_authority_never_guesses_from_english_tracks_or_title(self):
        result, opened = self.run_adapter({'title': 'English original TED talk',
            'defaultLanguage': 'en', 'subtitles': {'en': formats('en')}})
        self.assertEqual(result['status'], 'UNKNOWN_SOURCE_AUTHORITY')
        self.assertEqual(opened, [])


if __name__ == '__main__':
    unittest.main()
