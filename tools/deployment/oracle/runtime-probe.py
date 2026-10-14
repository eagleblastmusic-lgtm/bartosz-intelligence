"""Odczyt offline wersji i zależności; bez zapytań źródłowych i sekretów."""
import importlib.metadata
import json
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parents[3]
expected = dict(re.findall(r'^([A-Za-z0-9_-]+)==([^\s]+)$', (root / 'tools/gates/adapters/requirements-gate0.lock.txt').read_text(), re.M))
versions = {}
for name in expected:
    try:
        versions[name] = importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        versions[name] = None
ok = all(versions[key] == value for key, value in expected.items())
try:
    import yt_dlp
    import yt_dlp_ejs
    import youtube_transcript_api
    import requests
    import defusedxml
except Exception:
    ok = False
print(json.dumps({'ok': ok, 'python': '.'.join(map(str, sys.version_info[:3])), 'versions': versions}, sort_keys=True))
sys.exit(0 if ok else 1)
