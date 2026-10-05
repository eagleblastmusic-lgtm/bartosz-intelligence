import importlib.util
import json
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('production_captions',ROOT/'apps/executor/python/transcript_ytdlp.py')
adapter=importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
class TranscriptAdapterTests(unittest.TestCase):
    def test_original_vendor_alias_preserves_provenance_and_deduplicates(self):
        formats=[{'ext':'json3','url':'https://www.youtube.com/api/timedtext?lang=en&kind=asr'}]
        tracks=adapter.tracks_from_info({'automatic_captions':{'en':formats,'en-orig':formats}})
        self.assertEqual(len(tracks),1)
        self.assertEqual(tracks[0]['language_code'],'en')
        self.assertTrue(tracks[0]['is_original'])
        self.assertFalse(tracks[0]['is_translated'])
    def test_raw_source_text_and_original_cue_times(self):
        payload=json.dumps({'events':[{'tStartMs':250,'dDurationMs':3250,'segs':[{'utf8':'e\u0301  &amp; <literal>\nSource'}]}]}).encode()
        cue=adapter.decode_segments(payload,'json3')[0]
        self.assertEqual(cue['start_ms'],250)
        self.assertEqual(cue['end_ms'],3500)
        self.assertEqual(cue['text'],'e\u0301  &amp; <literal>\nSource')
    def test_translated_track_is_never_labeled_native_and_urls_are_private(self):
        info={'automatic_captions':{'pl':[{'ext':'json3','url':'https://www.youtube.com/api/timedtext?lang=en&tlang=pl&signature=private-fixture'}]}}
        track=adapter.tracks_from_info(info)[0]
        self.assertEqual(track['track_kind'],'TRANSLATED')
        self.assertTrue(track['is_translated'])
        self.assertEqual(track['source_language'],'en')
        public={key:value for key,value in track.items() if not key.startswith('_')}
        self.assertNotIn('private-fixture',json.dumps(public))
    def test_parser_failures_and_size_limits_remain_explicit(self):
        self.assertIsNone(adapter.decode_segments(b'{"events":[{"tStartMs":-1,"dDurationMs":1,"segs":[{"utf8":"x"}]}]}','json3'))
        with self.assertRaises(adapter.qualified.TooLargeResponse):
            adapter.decode_segments(b' '* (adapter.qualified.MAX_RESPONSE_BYTES+1),'json3')
    def test_caption_url_cannot_escape_youtube_timedtext(self):
        for url in ['https://evil.invalid/api/timedtext','https://www.youtube.com.evil.invalid/api/timedtext','https://www.youtube.com:444/api/timedtext','https://user@www.youtube.com/api/timedtext']:
            self.assertEqual(adapter.tracks_from_info({'subtitles':{'en':[{'ext':'json3','url':url}]}}),[])
if __name__=='__main__':unittest.main()
