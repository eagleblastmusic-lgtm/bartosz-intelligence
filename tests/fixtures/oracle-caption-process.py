"""Proces testowy: prawdziwy timeout/abort/env bez ruchu do źródła."""
import json
import os
import sys
import time

request = json.load(sys.stdin)
if request['operation'] == 'fetch':
    time.sleep(10)
elif request['video_id'] == 'failure0001':
    sys.stderr.write('synthetic-private-provider-body')
    sys.exit(9)
elif request['video_id'] == 'badjson0001':
    sys.stdout.write('synthetic-private-provider-body')
else:
    print(json.dumps({'ok': True, 'deno': os.environ.get('BARTOSZ_DENO'), 'ffmpeg': os.environ.get('BARTOSZ_FFMPEG'), 'credential_present': 'LOCAL_WORKER_CREDENTIAL' in os.environ, 'ai_secret_present': 'GEMINI_API_KEY' in os.environ}))
