"""Prepare source configurations from the existing real records; no network."""
import argparse
from decimal import Decimal, ROUND_HALF_UP
from hashlib import sha256
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    for video in ['aircAruvnKk', 'IHZwWFHWa-w', 'LPZh9BOjkQs']:
        path = ROOT / f'tools/firefox-transcript-diagnostic-2026-10-12/evidence/{video}.reference.json'
        raw = path.read_bytes()
        record = json.loads(raw)
        segments = []
        for i, cue in enumerate(record['segments']):
            start, duration = Decimal(str(cue['start'])), Decimal(str(cue['duration']))
            milliseconds = lambda n: int((n * 1000).quantize(Decimal(1), rounding=ROUND_HALF_UP))
            segments.append({'upstream_index': i, 'start_ms': milliseconds(start),
                'end_ms': milliseconds(start + duration), 'text': cue['text'], 'speaker_label': None})
        reference = {'schema': 'ote-reference:1', 'video_id': video, 'language_code': record['language'],
            'track_kind': 'UNKNOWN', 'vss_id': None, 'independent': False, 'complete': False, 'original': False,
            'provenance': record['source'] + '; historical diagnostic record, not an independent complete reference',
            'raw_sha256': sha256(raw).hexdigest(), 'segments': segments}
        reference_raw = (json.dumps(reference, ensure_ascii=False, indent=2) + '\n').encode()
        (out / f'{video}.reference.json').write_bytes(reference_raw)
        snapshot = {'video_id': video, 'playability_status': 'OK', 'tracks_explicit': True,
            'original_language': None, 'tracks': [{'vss_id': None, 'language_code': record['language'],
                'kind': 'UNKNOWN', 'name': 'Recorded EN diagnostic track; authority unknown', 'is_translated': None}]}
        (out / f'{video}.snapshot.json').write_text(json.dumps(snapshot, indent=2) + '\n', encoding='utf-8')
        config = {'schema': 'ote-source:1', 'format': 'recorded-en', 'path': os.path.relpath(path, out),
            'snapshot_path': f'{video}.snapshot.json', 'reference_path': f'{video}.reference.json',
            'reference_sha256': sha256(reference_raw).hexdigest()}
        (out / f'{video}.source.json').write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    pl_path = ROOT / 'tools/firefox-transcript-v0.4.2/evidence/bartosz-transcript-aircAruvnKk.json'
    pl_snapshot = {'video_id': 'aircAruvnKk', 'playability_status': 'OK', 'tracks_explicit': True,
        'original_language': None, 'tracks': [{'vss_id': None, 'language_code': 'pl', 'kind': 'UNKNOWN',
            'name': 'Recorded PL DOM; identity and original authority unknown', 'is_translated': None}]}
    (out / 'aircAruvnKk.pl-dom.snapshot.json').write_text(json.dumps(pl_snapshot, indent=2) + '\n', encoding='utf-8')
    (out / 'aircAruvnKk.pl-dom.source.json').write_text(json.dumps({'schema': 'ote-source:1',
        'format': 'recorded-dom', 'path': os.path.relpath(pl_path, out),
        'snapshot_path': 'aircAruvnKk.pl-dom.snapshot.json'}, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'prepared': 4, 'mode': 'OFFLINE_REPLAY', 'live_requests': 0}))


if __name__ == '__main__':
    main()
