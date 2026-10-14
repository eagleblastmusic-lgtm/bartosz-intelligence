#!/usr/bin/python3 -I
"""Root-owned launcher, executed exclusively as the dedicated nonroot account."""
import json
import os
from pathlib import Path
import sys


def main():
    root=Path(__file__).absolute().parent
    if not str(root).startswith('/opt/bartosz-intelligence/browser-runtimes/chromium-headless-shell-'):
        raise RuntimeError('MANAGED_PATH_REQUIRED')
    # -I ignores PYTHONPATH/PYTHONHOME; import only the root-managed sibling.
    for p in list(root.parents)+[root,root/'policy.py',root/'runtime.json']:
        s=p.lstat()
        if p.is_symlink() or s.st_uid!=0 or s.st_mode & 0o022:
            raise RuntimeError('UNTRUSTED_LAUNCHER_LOCATION')
    sys.path.insert(0,str(root))
    import policy
    c=policy.validate_config(policy.load(root/'runtime.json'))
    policy.require(str(root)==c['runtime_root'],'MANAGED_PATH_REQUIRED')
    policy.validate_runtime(c)
    if sys.argv[1:]==['--validate-only']:
        print(json.dumps({'configuration':'PASS','sandbox_active':'NOT_TESTED','accepted':False}))
        return
    profile=policy.private_profile(c,sys.argv[1:])
    for fd in [3,4]:
        os.fstat(fd)
        os.set_inheritable(fd,True)
    os.execve(c['executable'],[c['executable']]+sys.argv[1:],policy.clean_environment(profile))


if __name__=='__main__':
    try:main()
    except Exception as e:
        code=str(e) if isinstance(e,(ValueError,RuntimeError)) and str(e).replace('_','').isalnum() else 'MANAGED_LAUNCH_REJECTED'
        print(json.dumps({'launch':'REFUSED','code':code,'accepted':False}),file=sys.stderr)
        raise SystemExit(78)
