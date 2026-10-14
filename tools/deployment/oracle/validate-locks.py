"""Walidacja spójności pinów; działa offline i nie wykonuje instalacji."""
import json
from pathlib import Path
import re
from urllib.parse import urlparse

root = Path(__file__).resolve().parents[3]
manifest = json.loads((root / 'package.json').read_text())
lock = json.loads((root / 'tools/deployment/oracle/runtime-lock.json').read_text())
assert manifest['engines']['node'] == lock['node']['version'] == (root / '.node-version').read_text().strip()
assert manifest['engines']['pnpm'] == lock['pnpm']['version']
assert manifest['packageManager'] == 'pnpm@' + lock['pnpm']['version']
hosts = {'node': 'nodejs.org', 'deno': 'github.com', 'pnpm': 'registry.npmjs.org'}
for name, record in lock.items():
    url = urlparse(record['url'])
    assert url.scheme == 'https' and url.hostname == hosts[name] and not url.username and not url.password
    assert re.fullmatch('[a-f0-9]{64}', record['sha256'])
expected = dict(re.findall(r'^([A-Za-z0-9_-]+)==([^\s]+)$', (root / 'tools/gates/adapters/requirements-gate0.lock.txt').read_text(), re.M))
actual = {}
for line in (root / 'tools/deployment/oracle/requirements-arm64.lock.txt').read_text().splitlines():
    if not line or line.startswith('#'):
        continue
    match = re.fullmatch(r'([A-Za-z0-9_-]+) @ (https://files\.pythonhosted\.org/\S+\.whl) --hash=sha256:([a-f0-9]{64})', line)
    assert match
    name, url, digest = match.groups()
    filename = url.rsplit('/', 1)[1]
    assert filename.startswith(name.replace('-', '_') + '-' + expected[name] + '-')
    assert filename.endswith(('py3-none-any.whl', 'py2.py3-none-any.whl'))
    assert name not in actual
    actual[name] = expected[name]
assert actual == expected
print(json.dumps({'locks': 'PASS', 'node': lock['node']['version'], 'pnpm': lock['pnpm']['version'], 'deno': lock['deno']['version'], 'python_wheels': len(actual)}))
