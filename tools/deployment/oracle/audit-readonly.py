"""Testy parsera w pamięci istniejącego hosta; stdin zawiera kod, bez zapisu plików."""
import hashlib
import importlib.abc
import importlib.metadata
import importlib.util
import io
import json
import platform
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

payload = json.load(sys.stdin)
sources = payload['sources']
allowed = {'apps/executor/python/transcript_ytdlp.py', 'tools/gates/adapters/gate0_python_adapters.py', 'tests/unit/test_transcript_ytdlp.py'}
assert set(sources) == allowed
original_spec = importlib.util.spec_from_file_location
class MemoryLoader(importlib.abc.Loader):
    def __init__(self, key):
        self.key = key
    def create_module(self, spec):
        return None
    def exec_module(self, module):
        module.__file__ = '/bartosz-memory/' + self.key
        exec(compile(sources[self.key], module.__file__, 'exec'), module.__dict__)
def memory_spec(name, path, *args, **kwargs):
    match = next((key for key in sources if str(path).replace('\\', '/').endswith(key)), None)
    return importlib.util.spec_from_loader(name, MemoryLoader(match)) if match else original_spec(name, path, *args, **kwargs)
importlib.util.spec_from_file_location = memory_spec
spec = memory_spec('oracle_parser_tests', '/bartosz-memory/tests/unit/test_transcript_ytdlp.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
stream = io.StringIO()
result = unittest.TextTestRunner(stream=stream).run(unittest.defaultTestLoader.loadTestsFromModule(module))
def command(args):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=15)
        return {'exit': r.returncode, 'version': r.stdout.splitlines()[:1]}
    except Exception:
        return {'exit': None, 'version': []}
versions = {}
for package in payload['packages']:
    try: versions[package] = importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError: versions[package] = None
syntax = {}
for name, body in payload['shell_scripts'].items():
    syntax[name] = subprocess.run(['/bin/bash', '-n'], input=body, text=True, capture_output=True, timeout=10).returncode
print(json.dumps({
    'observed_utc': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),
    'architecture': platform.machine(), 'python': platform.python_version(),
    'parser_tests': {'run': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors), 'success': result.wasSuccessful()},
    'source_sha256': {key: hashlib.sha256(body.encode()).hexdigest() for key, body in sources.items()},
    'shell_syntax': syntax, 'shell_sha256': {name: hashlib.sha256(body.encode()).hexdigest() for name, body in payload['shell_scripts'].items()}, 'packages': versions,
    'node_in_path': shutil.which('node'), 'pnpm_in_path': shutil.which('pnpm'),
    'deno': command(['/home/ubuntu/.deno/bin/deno', '--version']), 'ffmpeg': command(['/usr/bin/ffmpeg', '-version']),
    'system_packages': subprocess.run(['dpkg-query', '-W', '-f=${binary:Package}=${Version}\n', 'python3.12', 'python3.12-venv', 'ffmpeg', 'curl', 'ca-certificates', 'unzip', 'xz-utils', 'util-linux'], capture_output=True, text=True, timeout=15).stdout.splitlines(),
    'remote_files_written': False, 'source_requests': 0,
}, sort_keys=True))
sys.exit(0 if result.wasSuccessful() and all(code == 0 for code in syntax.values()) else 1)
