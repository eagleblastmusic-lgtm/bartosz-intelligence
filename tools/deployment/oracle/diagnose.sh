#!/usr/bin/env bash
# Tylko odczyt. Nie wyświetla env, pełnych command line ani treści transkrypcji.
set -euo pipefail
systemctl show bartosz-executor --property=ActiveState,SubState,Result,NRestarts,MainPID,MemoryCurrent,MemoryPeak,CPUUsageNSec,TasksCurrent
df -h /opt/bartosz-intelligence /var/lib/bartosz-executor
free -m
cat /proc/loadavg
journalctl -u bartosz-executor -n 30 --no-pager --output=cat | /usr/bin/python3 -c 'import sys,json; allowed={"event","worker_id","exit_code","code","accepted","idle","source_qualified","concurrency","status","route"};
for line in sys.stdin:
 try:
  value=json.loads(line); print(json.dumps({k:v for k,v in value.items() if k in allowed}))
 except (ValueError,AttributeError): pass'
