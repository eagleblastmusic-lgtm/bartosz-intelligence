#!/usr/bin/python3 -I
"""Prepared nonroot v2 launcher; direct ELF remains covered by attachment."""
import json
import os
from pathlib import Path
import sys


def main():
    root=Path(__file__).absolute().parent
    if str(root)!='/opt/bartosz-intelligence/browser-runtimes/chromium-headless-shell-153.0.8010.12':
        raise RuntimeError('V2_MANAGED_PATH_REQUIRED')
    for p in [*root.parents,root,root/'enforced.py',root/'policy.py',root/'enforced-runtime.json',root/'v2-library-lock.json']:
        s=p.lstat()
        if p.is_symlink()or s.st_uid!=0 or s.st_mode&0o022:raise RuntimeError('V2_UNTRUSTED_LAUNCHER')
    sys.path.insert(0,str(root))
    import enforced,policy
    c=enforced.validate_config(policy.load(root/'enforced-runtime.json'));lock=enforced.load_lock(root/'v2-library-lock.json')
    enforced.validate_runtime(c,lock)
    if sys.argv[1:]==['--validate-only']:
        print(json.dumps({'configuration':'PASS','LIBRARY_BOUNDARY_READINESS':'NOT_TESTED_ACTIVE_POLICY_REQUIRED','accepted':False}));return
    profile=policy.private_profile(c,sys.argv[1:])
    for fd in [3,4]:os.fstat(fd);os.set_inheritable(fd,True)
    os.execve(c['executable'],[c['executable']]+sys.argv[1:],policy.clean_environment(profile))


if __name__=='__main__':
    try:main()
    except Exception as e:
        code=str(e)if isinstance(e,(ValueError,RuntimeError))and str(e).replace('_','').isalnum()else'V2_LAUNCH_REFUSED'
        print(json.dumps({'launch':'REFUSED','code':code,'accepted':False}),file=sys.stderr);raise SystemExit(78)
