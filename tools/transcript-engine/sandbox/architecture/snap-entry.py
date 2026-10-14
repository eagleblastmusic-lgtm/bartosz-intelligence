#!/usr/bin/python3 -I
"""Same dedicated user's supported session bus; preserve CDP FD3/4 by exec."""
import os
import pwd
import sys

a=pwd.getpwnam('bartosz-browser')
if os.getuid()!=a.pw_uid or os.getuid()==0:raise SystemExit('DEDICATED_NONROOT_BROWSER_REQUIRED')
environment={k:v for k,v in os.environ.items()if k in {'PATH','HOME','TMPDIR','LANG'}}
environment['XDG_RUNTIME_DIR']='/run/user/'+str(a.pw_uid)
environment['DBUS_SESSION_BUS_ADDRESS']='unix:path='+environment['XDG_RUNTIME_DIR']+'/bus'
os.execve('/snap/bin/chromium',['/snap/bin/chromium',*sys.argv[1:]],environment)
