import hashlib
import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools/gates"))
from source_reference_probe import compare_source, source_cues


class SourceReferenceTests(unittest.TestCase):
    def test_exact_millisecond_fields_and_full_replay(self):
        raw = json.dumps({"events": [{"tStartMs": 3833, "dDurationMs": 3879,
                                      "segs": [{"utf8": "Żółć &amp; text"}]}]}).encode()
        cues = source_cues(raw)
        self.assertEqual(cues[0]["end_ms"], 7712)
        original = {"cue_count": 1, **{k: cues[0] for k in ("first_cue", "middle_cue", "last_cue")}}
        result = compare_source(raw, original, [hashlib.sha256(raw).hexdigest()])
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["all_cue_max_delta_ms"], 0)
        self.assertEqual(compare_source(raw, original, ["different"])["status"], "INCONCLUSIVE")

    def test_missing_duration_and_non_integer_time_never_synthesize_timestamps(self):
        for event in ({"tStartMs": 1}, {"tStartMs": True, "dDurationMs": 1}, {"tStartMs": 1.5, "dDurationMs": 1}):
            with self.assertRaises(ValueError):
                source_cues(json.dumps({"events": [{**event, "segs": [{"utf8": "text"}]}]}).encode())


if __name__ == "__main__":
    unittest.main()
