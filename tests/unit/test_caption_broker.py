import importlib.util
import base64
import hashlib
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('caption_broker',
    Path(__file__).resolve().parents[2]/'tools/transcript-engine/caption-broker.py')
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


class CaptionBrokerContract(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.now = 100
        self.selected = {'language_code': 'en', 'track_kind': 'MANUAL', 'extension': 'json3',
            'is_generated': False, 'is_translated': False, 'source_language': None,
            'translation_source_track_id': None, 'is_translatable': None,
            'translation_languages': [], 'is_original': True}
        self.response = {'status': 'OK', 'failure_code': None, 'provider_version': '2026.8.19',
            'python_version': '3.12.3', 'tracks': [self.selected], 'video_language': 'en',
            'selected': self.selected, 'segments': [{'upstream_index': 0, 'start_ms': 0,
                'end_ms': 1000, 'text': 'offline fixture', 'speaker_label': None}],
            'raw_payload_base64': 'e30=', 'raw_payload_hash': 'a'*64,
            'upstream_requests': 8, 'bytes_received': 2}
        def capture(video, maximum, connection, item_id):
            self.calls.append((video, maximum))
            return self.response
        self.service = broker.CaptionBroker(capture, lambda: self.now)
        self.listing = {'operation': 'list', 'video_id': 'aircAruvnKk', 'max_bytes': 4096,
            'item_id': '01234567-89ab-cdef-0123-456789abcdef'}
        self.fetch = {**self.listing, 'operation': 'fetch', 'language_code': 'en',
            'track_kind': 'MANUAL', 'extension': 'json3'}

    def test_list_fetch_reuses_exact_capture_once(self):
        listing = self.service.execute(self.listing, None)
        self.assertEqual(listing['tracks'], [self.selected])
        self.assertIsNone(listing['raw_payload_base64'])
        self.assertEqual(listing['segments'], [])
        self.assertEqual(self.service.execute(self.fetch, None), self.response)
        self.assertEqual(len(self.calls), 1)
        self.assertIsNone(self.service.cached)
        self.assertEqual(self.service.execute(self.fetch, None)['status'], 'UPSTREAM_CHANGED')
        self.assertEqual(len(self.calls), 1)

    def test_mismatched_track_does_not_retrieve_other_source(self):
        self.service.execute(self.listing, None)
        self.assertEqual(self.service.execute({**self.fetch, 'language_code': 'fr'}, None)['status'], 'UPSTREAM_CHANGED')
        self.assertIsNone(self.service.cached)
        self.assertEqual(len(self.calls), 1)

    def test_cache_expiry_requires_new_list(self):
        self.service.execute(self.listing, None)
        self.now += 121
        self.assertEqual(self.service.execute(self.fetch, None)['status'], 'UPSTREAM_CHANGED')
        self.assertEqual(len(self.calls), 1)

    def test_fetch_smaller_limit_drops_capture(self):
        self.service.execute(self.listing, None)
        self.assertEqual(self.service.execute({**self.fetch, 'max_bytes': 1}, None)['status'], 'TOO_LARGE')
        self.assertIsNone(self.service.cached)

    def test_only_typed_caption_inputs_accepted(self):
        for value in [{**self.listing, 'command': '/bin/bash'},
            {**self.listing, 'video_id': 'aircAruvnKk;id'},
            {**self.listing, 'max_bytes': True}, {**self.listing, 'max_bytes': 4194305},
            {**self.listing, 'item_id': '../../evil'},
            {**self.listing, 'operation': 'login'}, {**self.fetch, 'extension': '/tmp/x'},
            {**self.fetch, 'track_kind': 'TRANSLATED'}]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError): self.service.execute(value, None)
        self.assertEqual(self.calls, [])

    def test_public_track_projection_omits_url_cookie_token(self):
        value = broker.public_track({**self.selected, '_url': 'https://signed.invalid/?token=secret',
            'cookies': 'secret', 'poToken': 'secret'})
        self.assertEqual(value, self.selected)

    def test_real_capture_projection_ignores_advertised_translations_and_preserves_source(self):
        translated = {**self.selected, 'language_code':'pl', 'track_kind':'TRANSLATED',
            'is_translated':True, 'source_language':'en', 'is_original':None}
        raw = b'{"events":[]}'
        segments = json.dumps([{'start_ms':0,'end_ms':1000,'text':'caption fixture'}]).encode()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'receipt.json'
            receipt = {'status':'COMPLETED','authentication_status':'AUTHENTICATED',
                'resources':{'category':'NONE','exit_code':0},
                'result':{'status':'CAPTIONS_RECEIVED','provider_tracks':[translated,self.selected],
                    'provider_selected':self.selected,'python_version':'3.12.3','video_language':'en'},
                'files':{}}
            for name,body in [('caption.raw',raw),('segments.json',segments)]:
                (path.parent/name).write_bytes(body)
                receipt['files'][name]={'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()}
            with patch.object(broker,'check_root_file'):
                result = broker.project_capture(receipt,path,0,4096)
        self.assertEqual(result['status'],'OK')
        self.assertEqual(result['tracks'],[self.selected])
        self.assertEqual(result['selected'],self.selected)
        self.assertEqual(base64.b64decode(result['raw_payload_base64']),raw)
        self.assertEqual(result['segments'][0]['text'],'caption fixture')

    def test_disconnected_client_detected(self):
        left, right = socket.socketpair()
        try:
            self.assertFalse(broker.connection_closed(left))
            right.close()
            self.assertTrue(broker.connection_closed(left))
        finally:
            left.close()
            right.close()

    def test_input_frame_rejects_over_limit(self):
        left, right = socket.socketpair()
        try:
            right.sendall(b'x'*8193)
            with self.assertRaises(ValueError): broker.receive_input(left)
        finally:
            left.close()
            right.close()


if __name__ == '__main__':
    unittest.main()
