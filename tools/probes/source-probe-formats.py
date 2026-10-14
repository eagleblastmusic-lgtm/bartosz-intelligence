"""Kontrola parsera ARM64/Windows; brak transportu i danych produkcyjnych.

Kontrole są syntetyczne i nie potwierdzają działania źródła live.
"""
from hashlib import sha256
from pathlib import Path
import importlib.metadata
import importlib.util
import json
import platform
import sys

ROOT = Path(__file__).resolve().parents[2]
ADAPTER = ROOT / 'apps/executor/python/transcript_ytdlp.py'
spec = importlib.util.spec_from_file_location('source_probe_caption_adapter', ADAPTER)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
fixture = ROOT / 'tests/fixtures/source-probe'
expected = [
    {'upstream_index': 0, 'start_ms': 4220, 'end_ms': 5400, 'text': 'fixture alpha', 'speaker_label': None},
    {'upstream_index': 1, 'start_ms': 6060, 'end_ms': 10713, 'text': 'fixture alpha', 'speaker_label': None},
]
checks = []
for extension, name in [('json3', 'same-cues.json3'), ('vtt', 'same-cues.vtt'), ('srv3', 'same-cues.srv3')]:
    body = (fixture / name).read_bytes()
    cues = adapter.decode_segments(body, extension)
    checks.append({'format': extension, 'sha256': sha256(body).hexdigest(),
                   'matches_control': cues == expected, 'segment_count': len(cues or []),
                   'first_start_ms': cues[0]['start_ms'] if cues else None,
                   'last_end_ms': cues[-1]['end_ms'] if cues else None})
assert all(row['matches_control'] for row in checks)

# Zmienna duration naprawdę nie występuje; nie wolno wynaleźć końca z następnego startu.
from youtube_transcript_api._transcripts import _TranscriptParser
missing_duration = b'<transcript><text start="1">fixture alpha</text></transcript>'
third_party = _TranscriptParser().parse(missing_duration.decode())
strict = adapter.decode_segments(missing_duration, 'xml')
assert third_party[0].duration == 0.0 and strict is None
print(json.dumps({
    'schema': 'source-probe-formats:1', 'scope': 'SYNTHETIC_OFFLINE_CONTROL_ONLY',
    'system': sys.platform, 'architecture': platform.machine(), 'python': platform.python_version(),
    'network_requests': 0, 'source_complete': False,
    'adapter_sha256': sha256(ADAPTER.read_bytes()).hexdigest(),
    'youtube_transcript_api_version': importlib.metadata.version('youtube-transcript-api'),
    'checks': checks,
    'missing_duration': {'fixture_sha256': sha256(missing_duration).hexdigest(),
                         'third_party_duration': third_party[0].duration,
                         'strict_adapter_rejected': strict is None,
                         'scope': 'Parser behavior, not a claim that recorded real transcripts lost duration'}
}, ensure_ascii=False, indent=2))
