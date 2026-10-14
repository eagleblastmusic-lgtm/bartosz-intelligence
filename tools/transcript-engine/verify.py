"""Independent evidence acceptance: Decimal timing reader, not the TS decoder.

Checks every text/start/end, source projections, host parity, terminal refusals,
resource controls and bundle identity. Does not elevate replay to live success.
"""
import argparse
from decimal import Decimal, ROUND_HALF_UP
from hashlib import sha256
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IDS = ['aircAruvnKk', 'IHZwWFHWa-w', 'LPZh9BOjkQs']
HASHES = ['1fa462a48a8872f16b2dcc4839f0d3b7a277cc878649e122fb5f8a83e0fcd61c',
          '335fdde6c2e7fca83edc630552a986b7ae2b00bc5cc1deff6aaf557bd2d62d16',
          '7c9c9b6b524ceef0f983f32abedafc89259b5defc639821896e860e1e10ecdb4']


def load(path):
    assert path.stat().st_size <= 8 * 1024 * 1024, path.name
    return json.loads(path.read_text(encoding='utf-8'))


def expected(video):
    path = ROOT / f'tools/firefox-transcript-diagnostic-2026-10-12/evidence/{video}.reference.json'
    assert sha256(path.read_bytes()).hexdigest() == HASHES[IDS.index(video)]
    record = load(path)
    assert record['video_id'] == video
    cues = []
    def ms(n):
        return int((n * 1000).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    for i, c in enumerate(record['segments']):
        start, duration = Decimal(str(c['start'])), Decimal(str(c['duration']))
        cues.append({'upstream_index': i, 'start_ms': ms(start), 'end_ms': ms(start + duration),
                     'text': c['text'], 'speaker_label': None})
    return cues


def accept_replay(result, video):
    assert result['video_id'] == video
    assert result['acquisition'] == 'OFFLINE_REPLAY'
    assert result['accepted'] is False
    assert result['segments'] == expected(video), video
    assert result['full_text'] == '\n'.join(c['text'] for c in expected(video))
    assert result['completeness']['independently_confirmed_complete'] is False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--windows', type=Path, required=True)
    parser.add_argument('--oracle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--pl', type=Path)
    args = parser.parse_args()
    win, oracle = args.windows, args.oracle
    win_browser = load(win / 'browser.json')
    oracle_browser = load(oracle / 'evidence/browser/browser.json')
    assert win_browser['test_count'] == oracle_browser['test_count'] == 12
    comparisons = []
    for i, video in enumerate(IDS):
        name = f'{video}-real-text-replay'
        w = load(win / (name + '.result.json'))
        o = load(oracle / 'evidence/browser' / (name + '.result.json'))
        accept_replay(w, video)
        accept_replay(o, video)
        assert w == o, video
        wp = load(win / (name + '.source-projection.json'))
        op = load(oracle / 'evidence/browser' / (name + '.source-projection.json'))
        assert wp == op
        assert set(wp) == {'segments', 'selected_label', 'list_terminal'}
        assert len(wp['segments']) == len(expected(video))
        for raw, cue in zip(wp['segments'], expected(video), strict=True):
            assert set(raw) == {'startMs', 'endMs', 'snippet'}
            assert set(raw['snippet']) == {'simpleText'}
            assert raw['snippet']['simpleText'] == cue['text']
            assert int(raw['startMs']) == cue['start_ms'] and int(raw['endMs']) == cue['end_ms']
        assert win_browser['records'][i]['cues_sha256'] == oracle_browser['records'][i]['cues_sha256']
        comparisons.append({'video_id': video, 'cue_count': len(expected(video)),
            'every_text_and_start_and_end_equal': True, 'host_results_equal': True,
            'real_record_kind': 'UNKNOWN', 'browser_player_metadata': 'RECONSTRUCTED_MANUAL_CONTROL',
            'original_authority': 'UNKNOWN', 'accepted': False})
    for browser in [win_browser, oracle_browser]:
        assert browser['live_youtube_requests'] == 0
        assert browser['records'][0]['cues_sha256'] == browser['records'][3]['cues_sha256']
        assert all(r['accepted'] is False and r['transcript_requests'] <= 1 and
                   r['external_server_requests'] == 0 and r['diagnostics']['profile_removed'] is True
                   for r in browser['records'])
    prefix = load(win / 'aircAruvnKk-prefix.result.json')
    assert prefix['category'] == 'PARTIAL_RESPONSE' and prefix['accepted'] is False
    detected = False
    try:
        accept_replay(prefix, IDS[0])
    except AssertionError:
        detected = True
    assert detected, 'Independent verifier must itself reject a valid prefix'
    manifest = load(ROOT / '.local/transcript-engine/build-manifest.json')
    remote = load(oracle / 'oracle.json')
    for path, value in manifest['inputs'].items():
        assert sha256((ROOT / path).read_bytes()).hexdigest() == value, path
    for path, value in manifest['outputs'].items():
        local = Path(path) if Path(path).is_absolute() else ROOT / path
        assert sha256(local.read_bytes()).hexdigest() == value, path
        assert remote['input_hashes']['tools/transcript-engine/' + local.name] == value, path
    resources = load(oracle / 'evidence/resource-controls/resources.json')
    assert resources['test_count'] == 3 and resources['status'] == 'PASS'
    for r in resources['results']:
        receipt = load(oracle / 'evidence/resource-controls' / r['receipt'])
        assert receipt['category'] == r['test'] and receipt['descendants_remaining'] == 0
    assert remote['temporary_files_removed'] is True
    assert remote['production_d1_calls'] == remote['services_started'] == 0
    assert load(oracle / 'evidence/blocked-live/result.json')['category'] == 'BLOCKED_AUTHORIZATION'
    result = {'schema': 'ote-independent-acceptance:1', 'status': 'PASS_OFFLINE_ONLY',
        'reader': 'INDEPENDENT_PYTHON_DECIMAL_NOT_TS_PARSER', 'comparisons': comparisons,
        'boundaries_compared_per_host': sum(2 * len(expected(v)) for v in IDS),
        'prefix_negative_control': 'PASS_REJECTED', 'bundle_identity': 'PASS',
        'real_live_caption_acquisitions': 0, 'production_d1_calls': 0,
        'decision': 'PARTIAL_RESEARCH_PRODUCTION_NO_GO'}
    if args.pl:
        pl = load(args.pl)
        original = load(ROOT / 'tools/firefox-transcript-v0.4.2/evidence/bartosz-transcript-aircAruvnKk.json')
        assert len(pl['segments']) == len(original['segments']) == 223
        for actual, source in zip(pl['segments'], original['segments'], strict=True):
            seconds = 0
            for number in source['timestamp'].split(':'):
                seconds = seconds * 60 + int(number)
            assert actual['text'] == source['text'] and actual['start_ms'] == seconds * 1000
            assert actual['end_ms'] is None
        assert pl['accepted'] is False and pl['category'] == 'PARTIAL_RESPONSE'
        result['pl_dom'] = {'cue_count': 223, 'every_text_and_start_equal': True,
            'end_ms': None, 'accepted': False, 'reason': 'MISSING_SOURCE_END_TIMES_AND_AUTHORITY'}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
