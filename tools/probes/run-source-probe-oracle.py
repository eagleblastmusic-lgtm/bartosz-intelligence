"""Wysyła izolowaną diagnostykę do /tmp; usuwa ją po odbiorze. Bez deploymentu.

Jedyny opcjonalny odczyt live: pojedynczy publiczny oEmbed, --live-oembed.
Nie przekazuje środowiska aplikacji ani klucza API transkrypcji.
"""
import argparse
import base64
import gzip
from hashlib import sha256
import io
import json
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--key', required=True, type=Path)
parser.add_argument('--live-oembed', action='store_true')
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
names = [p.relative_to(ROOT).as_posix() for p in (ROOT / 'tests/fixtures/source-probe').iterdir() if p.is_file()]
names += ['tools/probes/source-probe-formats.py', 'apps/executor/python/transcript_ytdlp.py',
          'tools/gates/adapters/gate0_python_adapters.py']
names += ['tools/firefox-transcript-diagnostic-2026-10-12/evidence/' + name + '.reference.json'
          for name in ['aircAruvnKk', 'IHZwWFHWa-w', 'LPZh9BOjkQs']]
names += ['tools/firefox-transcript-v0.4.2/evidence/' + name for name in
          ['bartosz-transcript-aircAruvnKk.json', 'fixture-export-aircAruvnKk.json']]
bodies = {name: (ROOT / name).read_bytes() for name in names}
for name in ['source-probe.mjs', 'source-probe-check.mjs']:
    bodies['tools/probes/' + name] = (ROOT / '.local/source-probe-20261013' / name).read_bytes()
stream = io.BytesIO()
with gzip.GzipFile(fileobj=stream, mode='wb', mtime=0, filename='') as compressed:
    with tarfile.open(fileobj=compressed, mode='w') as tar:
        for name, body in sorted(bodies.items()):
            entry = tarfile.TarInfo(name)
            entry.size = len(body)
            entry.mode = 0o600
            tar.addfile(entry, io.BytesIO(body))
archive = stream.getvalue()
(ROOT / '.local/source-probe-20261013/diagnostic.tar.gz').write_bytes(archive)
remote = '''
import base64, hashlib, io, json, os, pathlib, subprocess, tarfile, tempfile
blob = base64.b64decode("%s")
assert hashlib.sha256(blob).hexdigest() == "%s"
results = {}
with tempfile.TemporaryDirectory(prefix="bartosz-source-probe-") as temporary:
    root = pathlib.Path(temporary).resolve()
    assert root.parent == pathlib.Path(tempfile.gettempdir()).resolve()
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
        tar.extractall(root, filter="data")
    node = "/opt/bartosz-intelligence/runtime/node-24.21.0/bin/node"
    python = "/opt/bartosz-intelligence/runtime/python/bin/python"
    commands = {
      "offline": [node, "tools/probes/source-probe.mjs", "offline", "tests/fixtures/source-probe/offline.json"],
      "portable": [node, "tools/probes/source-probe-check.mjs"],
      "formats": [python, "-B", "tools/probes/source-probe-formats.py"],
      "native_blocked": [node, "tools/probes/source-probe.mjs", "supadata-native", "tests/fixtures/source-probe/native-blocked.json"]
    }
    if %s:
        commands["oembed"] = [node, "tools/probes/source-probe.mjs", "oembed", "tests/fixtures/source-probe/oembed.json"]
    for name, command in commands.items():
        run = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=40,
          env={"PATH":"/usr/bin:/bin", "PYTHONNOUSERSITE":"1", "PYTHONDONTWRITEBYTECODE":"1"})
        if run.returncode != 0:
            raise RuntimeError("REMOTE_DIAGNOSTIC_FAILED_" + name)
        results[name] = json.loads(run.stdout)
print(json.dumps({"schema":"source-probe-oracle:1", "diagnostic_archive_sha256":hashlib.sha256(blob).hexdigest(),
  "temporary_files_removed":not root.exists(), "release_modified":False, "production_d1_calls":0,
  "results":results}, ensure_ascii=False))
''' % (base64.b64encode(archive).decode(), sha256(archive).hexdigest(), repr(args.live_oembed))
ssh = ['ssh', '-F', 'NUL', '-i', str(args.key.resolve()), '-o', 'BatchMode=yes',
       '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'StrictHostKeyChecking=yes',
       '-o', 'ConnectTimeout=15', 'ubuntu@89.168.89.196', 'env -i PATH=/usr/bin:/bin /usr/bin/python3 -B -']
run = subprocess.run(ssh, input=remote.encode(), capture_output=True, timeout=150)
if run.returncode != 0:
    raise SystemExit('ORACLE_SOURCE_PROBE_FAILED; no raw SSH stderr retained')
result = json.loads(run.stdout)
result['file_hashes'] = {name: sha256(body).hexdigest() for name, body in sorted(bodies.items())}
args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'oracle_probe': 'PASS_EXECUTION_NOT_SOURCE_QUALIFICATION',
                  'temporary_files_removed': result['temporary_files_removed'],
                  'operations': list(result['results']), 'diagnostic_archive_sha256': sha256(archive).hexdigest()}))
