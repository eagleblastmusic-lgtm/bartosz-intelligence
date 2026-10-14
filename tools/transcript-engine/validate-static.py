"""Capture individual exit codes for required static checks, no package installs."""
import argparse
import ast
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    node = str(args.node.resolve())
    ts = sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'tools/transcript-engine').glob('*.ts'))
    commands = {
        'typecheck_tools': [node, 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.tools.json'],
        'lint_prototype': [node, 'node_modules/eslint/bin/eslint.js'] + ts + ['tools/transcript-engine/build.mjs'],
        'format_prototype': [node, 'node_modules/prettier/bin/prettier.cjs', '--check'] + ts + [
            'tools/transcript-engine/build.mjs', 'tests/fixtures/transcript-engine/native-blocked.json']}
    checks = {}
    for name, command in commands.items():
        start = time.monotonic()
        run = subprocess.run(command, cwd=ROOT, capture_output=True, timeout=90)
        checks[name] = {'exit_code': run.returncode, 'elapsed_ms': round((time.monotonic()-start)*1000),
            'stdout_sha256': sha256(run.stdout).hexdigest(), 'stderr_sha256': sha256(run.stderr).hexdigest()}
    for path in (ROOT / 'tools/transcript-engine').glob('*.py'):
        ast.parse(path.read_text(encoding='utf-8'), filename=path.name)
    checks['python_syntax'] = {'exit_code': 0}
    result = {'schema': 'ote-static-checks:1', 'checks': checks,
              'status': 'PASS' if all(c['exit_code'] == 0 for c in checks.values()) else 'FAIL'}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))
    return 0 if result['status'] == 'PASS' else 2


if __name__ == '__main__':
    raise SystemExit(main())
