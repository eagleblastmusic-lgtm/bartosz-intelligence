import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools" / "gates" / "adapters"))

from gate0_python_adapters import (  # noqa: E402
    CaptureSession,
    MAX_RESPONSE_BYTES,
    TooLargeResponse,
    parse_caption_payload,
    parse_json3,
    parse_srv3_xml,
    parse_vtt,
)

FIXTURES = REPO_ROOT / "tests" / "fixtures" / "gate0"


class Gate0PythonAdapterParserTests(unittest.TestCase):
    def test_multilingual_subprocess_json_is_utf8(self):
        value = {"track_name": "Zażółć 日本語 Español"}
        payload = json.dumps(value, ensure_ascii=False)
        result = subprocess.run(
            [sys.executable, "-c", "import sys; print(sys.argv[1])", payload],
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            capture_output=True, check=True,
        )
        self.assertEqual(json.loads(result.stdout.decode("utf-8")), value)

    def test_pinned_library_initializes_capture_session_without_network(self):
        from youtube_transcript_api import YouTubeTranscriptApi
        session = CaptureSession()
        try:
            YouTubeTranscriptApi(http_client=session)
            self.assertIn("Accept-Language", session.headers)
            self.assertEqual(session.observations, [])
        finally:
            session.close()

    def test_vtt_parses_millisecond_times_and_decodes_text_without_exposing_it(self):
        cues = parse_vtt((FIXTURES / "captions.vtt").read_bytes())
        self.assertEqual(len(cues or []), 2)
        self.assertEqual(cues[0]["start_ms"], 0)
        self.assertEqual(cues[0]["end_ms"], 1250)
        self.assertEqual(cues[0]["text_sha256"], "10a5e3e673d6c7024e457cd60e9ad580d0cecbe1f7354ac0694925cfda4969b2")
        self.assertNotIn("Hello & welcome", json.dumps(cues))

    def test_srv3_uses_hardened_xml_parser_and_decodes_entities(self):
        cues = parse_srv3_xml((FIXTURES / "captions.srv3.xml").read_bytes())
        self.assertEqual(len(cues or []), 2)
        self.assertEqual(cues[0]["start_ms"], 0)
        self.assertEqual(cues[0]["end_ms"], 1250)
        self.assertIsNone(parse_srv3_xml((FIXTURES / "captions-malformed.srv3.xml").read_bytes()))

    def test_json3_parser_rejects_malformed_and_missing_timestamps(self):
        self.assertIsNone(parse_json3(b"{malformed"))
        self.assertIsNone(parse_json3(b'{"events":[{"segs":[{"utf8":"no time"}]}]}'))
        cues = parse_json3(b'{"events":[{"tStartMs":125,"dDurationMs":500,"segs":[{"utf8":"A & B"}]}]}')
        self.assertEqual(cues[0]["start_ms"], 125)
        self.assertEqual(cues[0]["end_ms"], 625)

    def test_missing_vtt_timestamps_and_oversized_caption_are_rejected(self):
        self.assertIsNone(parse_vtt((FIXTURES / "captions-missing-time.vtt").read_bytes()))
        with self.assertRaises(TooLargeResponse):
            parse_caption_payload(b"x" * (MAX_RESPONSE_BYTES + 1), "vtt")


if __name__ == "__main__":
    unittest.main()
