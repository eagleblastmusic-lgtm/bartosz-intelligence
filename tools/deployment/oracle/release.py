"""Pakowanie dokładnych lokalnych bajtów i weryfikacja wydania; bez sekretów."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[3]
ROOT_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.node-version', 'tsconfig.base.json', 'tsconfig.tools.json', 'vitest.config.ts', 'playwright.config.ts', 'eslint.config.js', '.prettierrc.json', '.prettierignore']
NEW_FILES = ['apps/executor/src/oracle-runtime.ts', 'tools/executor/run-oracle.ts', 'tests/unit/oracle-runtime.spec.ts', 'tests/unit/oracle-deployment.spec.ts', 'tests/fixtures/oracle-caption-process.py', 'tests/contracts/oracle-worker.spec.ts', 'tests/contracts/oracle-source-qualification.spec.ts']
NEW_FILES += ['apps/executor/src/providers/oracle-captions.ts', 'packages/core/src/transcript/intake.ts',
    'tools/transcript-engine/caption-broker.py', 'tools/transcript-engine/login-diagnostic.py',
    'tools/transcript-engine/login-diagnostic-oracle.py', 'tools/transcript-engine/pot-transport-trace.mjs',
    'tests/unit/oracle-captions.spec.ts', 'tests/unit/test_caption_broker.py',
    'tests/unit/test_oracle_caption_selection.py', 'tests/unit/test_oracle_public_assets.py',
    'tests/workers/transcript-api.spec.ts', 'tests/unit/artifact-client-retry.spec.ts']
NEW_FILES += ['apps/api/src/artifact-repository.ts',
    'packages/core/src/sources/youtube/cycles.ts',
    'packages/core/src/transcript/payload-archive.ts',
    'packages/core/src/retention/payload-eviction.ts',
    'db/migrations/041_monitoring_cycles.sql', 'db/migrations/042_caption_retry.sql',
    'db/migrations/043_transcript_payload_archive.sql',
    'tests/unit/monitoring-slots.spec.ts', 'tests/workers/caption-retry-policy.spec.ts',
    'tests/workers/monitoring-cycles.spec.ts', 'tests/workers/performance-fixture.ts',
    'tests/workers/pipeline-performance.spec.ts', 'tools/performance/benchmark-pipeline.ts']
NEW_FILES += ['tests/workers/rss-fallback.spec.ts', 'tests/workers/transcript-audio-authority.spec.ts']

def sha(body):
    return hashlib.sha256(body).hexdigest()

def verify(root):
    manifest = json.loads((root / 'release-manifest.json').read_text())
    for name, expected in manifest['files'].items():
        path = root / name
        if Path(name).is_absolute() or '..' in Path(name).parts or path.is_symlink() or not path.is_file() or sha(path.read_bytes()) != expected:
            raise ValueError('RELEASE_INTEGRITY_FAILED')
    if not manifest['files']:
        raise ValueError('EMPTY_RELEASE')
    print(json.dumps({'release_integrity': 'PASS', 'file_count': len(manifest['files'])}))

def pack(output=None):
    tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', 'apps', 'packages', 'tools', 'tests', 'config', 'db'], cwd=ROOT).decode().split('\0')
    names = set(name for name in tracked if name and not Path(name).name.startswith('.env') and '.local' not in Path(name).parts)
    names.update(name for name in ROOT_FILES if (ROOT / name).is_file())
    names.update(NEW_FILES)
    names.update(path.relative_to(ROOT).as_posix() for path in (ROOT / 'tools/deployment/oracle').iterdir() if path.is_file() and path.name not in {'executor.env', '.env', '.dev.vars'} and path.suffix not in {'.key', '.pem', '.pyc'})
    bodies = {}
    for name in sorted(names):
        path = ROOT / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('RELEASE_FILE_UNAVAILABLE')
        bodies[name] = path.read_bytes()
    manifest = {'schema': 'bartosz-oracle-release:1', 'base_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip(), 'contains_local_changes': True, 'files': {name: sha(body) for name, body in bodies.items()}}
    bodies['release-manifest.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    output = Path(output).resolve() if output else ROOT / '.local/oracle-deployment'
    output.mkdir(parents=True, exist_ok=True)
    archive = output / 'executor.tar.gz'
    with archive.open('wb') as file:
        with gzip.GzipFile(fileobj=file, mode='wb', filename='', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as tar:
                for name, body in sorted(bodies.items()):
                    entry = tarfile.TarInfo(name)
                    entry.size = len(body)
                    entry.mode = 0o755 if name.endswith('.sh') else 0o644
                    tar.addfile(entry, io.BytesIO(body))
    digest = sha(archive.read_bytes())
    (output / 'executor.tar.gz.sha256').write_text(digest + '  executor.tar.gz\n', encoding='utf-8')
    print(json.dumps({'archive': str(archive), 'sha256': digest, 'base_commit': manifest['base_commit'], 'file_count': len(manifest['files'])}))

if __name__ == '__main__':
    if len(sys.argv) in (2, 3) and sys.argv[1] == 'pack':
        pack(sys.argv[2] if len(sys.argv) == 3 else None)
    elif len(sys.argv) == 3 and sys.argv[1] == 'verify':
        verify(Path(sys.argv[2]).resolve())
    else:
        sys.exit('Użycie: release.py pack [KATALOG_WYJSCIOWY] | verify KATALOG')
