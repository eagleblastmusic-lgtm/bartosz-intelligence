"""Collect only this experiment's evidence and create a deterministic runtime pack."""
import argparse
import gzip
from hashlib import sha256
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / '.local/transcript-engine'
OUT = ROOT / 'docs/verification/oracle/2026-10-13/original-transcript-engine'


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def copy(source, target):
    assert target.resolve().is_relative_to(OUT.resolve())
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True, type=Path)
    args = parser.parse_args()
    shutil.copytree(LOCAL / 'browser-final-windows', OUT / 'windows/browser', dirs_exist_ok=True)
    shutil.copytree(LOCAL / 'resource-windows', OUT / 'windows/resource-controls', dirs_exist_ok=True)
    shutil.copytree(LOCAL / 'pl-dom-windows', OUT / 'windows/pl-dom', dirs_exist_ok=True)
    shutil.copytree(LOCAL / 'auth-current-windows', OUT / 'windows/blocked-live', dirs_exist_ok=True)
    shutil.copytree(LOCAL / 'oracle-current/evidence', OUT / 'oracle/evidence', dirs_exist_ok=True)
    files = {
        'oracle-current/oracle.json': 'oracle/oracle.json',
        'windows-final-resources.json': 'windows/browser-resources.json',
        'portable-current-windows/portable.json': 'windows/portable.json',
        'portable-current-windows-resources.json': 'windows/portable-resources.json',
        'auth-blocked-windows-resources.json': 'windows/blocked-resources.json',
        'pl-dom-windows-resources.json': 'windows/pl-dom-resources.json',
        'independent-final.json': 'independent-acceptance.json',
        'sandbox-readonly.json': 'sandbox-readonly.json',
        'static-checks.json': 'static-checks.json',
        'build-manifest.json': 'build-manifest.json',
        'oracle-first/oracle.json': 'calibration/full-first.json',
        'oracle-first/evidence/browser-resources.json': 'calibration/full-first-resources.json',
        'oracle-targeted/oracle.json': 'calibration/full-single-page.json',
        'oracle-targeted/evidence/browser-resources.json': 'calibration/full-single-page-resources.json',
        'oracle-shell-targeted/oracle.json': 'calibration/shell-targeted.json',
        'oracle-shell-targeted/evidence/browser-resources.json': 'calibration/shell-targeted-resources.json'}
    for source, target in files.items():
        copy(LOCAL / source, OUT / target)
    sources = [ROOT / f'tools/firefox-transcript-diagnostic-2026-10-12/evidence/{v}.reference.json'
               for v in ['aircAruvnKk', 'IHZwWFHWa-w', 'LPZh9BOjkQs']]
    sources.append(ROOT / 'tools/firefox-transcript-v0.4.2/evidence/bartosz-transcript-aircAruvnKk.json')
    write(OUT / 'source-inputs.json', {'schema': 'ote-source-inputs:1', 'discovery': 'RG_FILES_THEN_READ_AND_HASH',
        'inputs': [{'path': p.relative_to(ROOT).as_posix(), 'sha256': sha256(p.read_bytes()).hexdigest(),
                    'bytes': p.stat().st_size, 'independent_complete_reference': False} for p in sources]})
    manifest = load(LOCAL / 'build-manifest.json')
    bodies = {p: (ROOT / p).read_bytes() for p in manifest['inputs']}
    for path in (ROOT / 'tools/transcript-engine').iterdir():
        if path.is_file() and path.suffix in {'.ts', '.py', '.mjs', '.md'}:
            bodies[path.relative_to(ROOT).as_posix()] = path.read_bytes()
    for name in ['transcript-engine.mjs', 'engine-check.mjs', 'browser-check.mjs', 'dom-reader.js', 'build-manifest.json']:
        bodies['tools/transcript-engine/' + name] = (LOCAL / name).read_bytes()
    for path in sources + [ROOT / 'tests/fixtures/transcript-engine/native-blocked.json',
                           ROOT / 'packages/contracts/src/transcript.ts']:
        bodies[path.relative_to(ROOT).as_posix()] = path.read_bytes()
    stream = io.BytesIO()
    with gzip.GzipFile(fileobj=stream, mode='wb', mtime=0, filename='') as compressed:
        with tarfile.open(fileobj=compressed, mode='w') as tar:
            for name, body in sorted(bodies.items()):
                entry = tarfile.TarInfo(name)
                entry.size, entry.mode = len(body), 0o600
                tar.addfile(entry, io.BytesIO(body))
    archive = stream.getvalue()
    (OUT / 'prototype.tar.gz').write_bytes(archive)
    with tempfile.TemporaryDirectory(prefix='package-acceptance-', dir=LOCAL) as temporary:
        root = Path(temporary).resolve()
        assert root.parent == LOCAL.resolve() and root.is_relative_to(ROOT)
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
            tar.extractall(root, filter='data')
        assert all((root / name).read_bytes() == body for name, body in bodies.items())
        run = subprocess.run([str(args.node.resolve()), '--max-old-space-size=192',
            str(root / 'tools/transcript-engine/engine-check.mjs'), str(root)], capture_output=True, timeout=20)
        assert run.returncode == 0, 'PACKAGE_ACCEPTANCE_FAILED'
        acceptance = json.loads(run.stdout)
        assert acceptance['status'] == 'PASS' and acceptance['test_count'] == 24
    write(OUT / 'package.json', {'schema': 'ote-package:1', 'sha256': sha256(archive).hexdigest(),
        'bytes': len(archive), 'files': len(bodies), 'deterministic_gzip_mtime': 0,
        'extraction_all_bytes_verified': True, 'extracted_portable_tests': acceptance['test_count'],
        'contains_browser_or_node': False, 'production_release': False})
    windows = load(OUT / 'windows/portable.json')
    oracle = load(OUT / 'oracle/evidence/portable/portable.json')
    assert windows == oracle and windows['test_count'] == 24
    assert load(OUT / 'static-checks.json')['status'] == 'PASS'
    assert load(OUT / 'independent-acceptance.json')['status'] == 'PASS_OFFLINE_ONLY'
    write(OUT / 'verification.json', {'schema': 'ote-final-verification:1',
        'decision': 'PARTIAL_RESEARCH_PRODUCTION_NO_GO', 'unique_scenarios': 39,
        'per_host': {'adapter': 24, 'browser': 12, 'resource_controls': 3},
        'identical_portable_results': True, 'independent_acceptance': 'PASS_OFFLINE_ONLY',
        'live': 'BLOCKED_AUTHORIZATION', 'new_youtube_caption_requests': 0,
        'production_d1_calls': 0, 'services_started': 0, 'commit_push_merge': False,
        'oracle_detached': load(OUT / 'oracle/oracle.json')['detached_execution']})
    evidence = {p.relative_to(OUT).as_posix(): sha256(p.read_bytes()).hexdigest()
                for p in sorted(OUT.rglob('*')) if p.is_file() and p.name != 'evidence-manifest.json'}
    code = {p.relative_to(ROOT).as_posix(): sha256(p.read_bytes()).hexdigest()
            for p in sorted((ROOT / 'tools/transcript-engine').iterdir()) if p.is_file()}
    write(OUT / 'evidence-manifest.json', {'schema': 'ote-evidence-manifest:1', 'files': evidence, 'source_files': code})
    print(json.dumps({'status': 'PASS', 'evidence_files': len(evidence), 'source_files': len(code),
                      'package_sha256': sha256(archive).hexdigest(), 'extracted_tests': 24}))


if __name__ == '__main__':
    main()
