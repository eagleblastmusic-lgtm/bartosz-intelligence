"""Sprawdzenie istniejących receipts, hashy i granic; bez sieci i Oracle."""
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/verification/oracle/2026-10-13/public-source-breakthrough'
read = lambda path: json.loads(path.read_text(encoding='utf-8-sig'))
digest = lambda path: sha256(path.read_bytes()).hexdigest()
write = lambda name, value: (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
windows = read(OUT / 'offline-windows.json')
oracle = read(OUT / 'oracle-final-offline.json')
assert oracle['temporary_files_removed'] and not oracle['release_modified']
assert oracle['production_d1_calls'] == 0
assert windows['manifest_sha256'] == oracle['results']['offline']['manifest_sha256']
def stable(row):
    return {key: value for key, value in row.items() if key not in {'system', 'architecture', 'elapsed_ms'}}
assert [stable(row) for row in windows['results']] == [stable(row) for row in oracle['results']['offline']['results']]
assert len(windows['results']) == 7
assert all(row['request_count'] == 0 and not row['levels']['INDEPENDENTLY_CONFIRMED_COMPLETE']
           and not row['caption_accepted'] for row in windows['results'])
portable_win = read(OUT / 'portable-windows.json')
portable_oci = oracle['results']['portable']
assert portable_win['pass'] and portable_oci['pass']
assert portable_win['checks'] == portable_oci['checks']
assert len(portable_win['checks']) == 6
assert portable_oci['architecture'] == 'arm64'
formats = read(OUT / 'formats-windows.json')
assert formats['checks'] == oracle['results']['formats']['checks']
assert formats['missing_duration'] == oracle['results']['formats']['missing_duration']
live_win = read(OUT / 'oembed-windows.json')['results'][0]
live_oci = read(OUT / 'oracle.json')['results']['oembed']['results'][0]
assert live_win['http_status'] == live_oci['http_status'] == 200
assert live_win['metadata_obtained'] and live_oci['metadata_obtained']
assert live_win['raw_sha256'] == live_oci['raw_sha256']
assert live_win['metadata_identity_sha256'] == live_oci['metadata_identity_sha256']
assert live_win['request_count'] == live_oci['request_count'] == 1
tests = read(OUT / 'tests-windows.json')
assert tests['success'] and tests['numPassedTests'] == 42 and tests['numFailedTests'] == 0
assert all(check['exit_code'] == 0 for check in read(OUT / 'static-checks.json')['checks'])
build = read(OUT / 'build-manifest.json')
for name, expected in build['inputs'].items(): assert digest(ROOT / name) == expected, name
for name, expected in build['files'].items(): assert digest(ROOT / name) == expected, name
for name, expected in oracle['file_hashes'].items():
    path = ROOT / name if not name.endswith('.mjs') else ROOT / '.local/source-probe-20261013' / Path(name).name
    assert digest(path) == expected, name
assert build['boundary'] == 'NO_D1_RPC_EXECUTOR_IMPORTS'
problems = []
for path in [OUT / 'REPORT_PL.md', ROOT / 'tools/probes/SOURCE_PROBE_PL.md']:
    for target in re.findall(r'\]\(([^)]+)\)', path.read_text(encoding='utf-8')):
        target = target.strip('<>').split('#')[0]
        if not target or re.match(r'https?://', target): continue
        if not (path.parent / target).exists(): problems.append((path.name, target))
assert not problems, problems
write('verification.json', {'schema':'source-probe-verification:1',
  'observed_utc': datetime.now(timezone.utc).isoformat(), 'status':'PASS_DIAGNOSTICS_NOT_CAPTION_QUALIFICATION',
  'test_count_windows':42, 'portable_checks_each_environment':6,
  'offline_records_equal_windows_oracle':7, 'formats_equal':['JSON3','VTT','SRV3'],
  'source_probe_build_sha256': next(value for name, value in build['files'].items() if name.endswith('/source-probe.mjs')),
  'oembed_requests_windows':1, 'oembed_requests_oracle':1, 'direct_caption_requests':0,
  'supadata_playground_run_clicks':1, 'supadata_api_requests':0,
  'production_d1_calls':0, 'oracle_temporary_files_removed':True,
  'independently_complete_captions_from_oracle':0, 'production_go':False})
files = {path.relative_to(ROOT).as_posix(): digest(path) for folder in
         [OUT, ROOT / 'tests/fixtures/source-probe'] for path in sorted(folder.rglob('*'))
         if path.is_file() and path.name != 'evidence-manifest.json'}
files.update({path.relative_to(ROOT).as_posix():digest(path) for path in (ROOT / 'tools/probes').glob('*source-probe*') if path.is_file()})
files['tests/unit/source-probe.spec.ts'] = digest(ROOT / 'tests/unit/source-probe.spec.ts')
files['tools/probes/SOURCE_PROBE_PL.md'] = digest(ROOT / 'tools/probes/SOURCE_PROBE_PL.md')
write('evidence-manifest.json', {'schema':'source-probe-evidence:1', 'files':files})
print(json.dumps({'verification':'PASS', 'bound_files':len(files), 'windows_tests':42,
                  'same_offline_records_windows_oracle':7, 'actual_caption_qualification':False}))
