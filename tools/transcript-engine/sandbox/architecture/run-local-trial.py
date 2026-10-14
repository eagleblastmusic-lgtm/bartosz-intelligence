"""Prepared one-job local Snap trial. Default prints a plan and executes nothing."""
import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid

ROOT=Path('/opt/bartosz-intelligence/browser-trial')
HOME=Path('/home/bartosz-browser')
JOBS=HOME/'snap/chromium/common/jobs'
NODE_HASH='0f8949d1028f6d61506b2d5bc57e7e6fe893d7b1997509b7847294fc9c616584'


def plan():
    return {'schema':'ote-snap-local-trial-plan:1','executes':False,'browser':'/snap/bin/chromium',
        'account':'bartosz-browser','home':HOME.as_posix(),'TMPDIR':JOBS.as_posix(),'memory_mib':768,
        'timeout_seconds':100,'concurrency':1,'network':'LOCAL_HARNESS_ONLY',
        'production_executor':False,'LIVE_SOURCE_ACCESS':'BLOCKED_AUTHORIZATION','accepted':False,
        'command':['/usr/bin/python3','-I',(ROOT/'supervise.py').as_posix(),'--memory-mib','768','--timeout','100','--',
            (ROOT/'node').as_posix(),'--max-old-space-size=192',(ROOT/'browser-check.mjs').as_posix(),
            (ROOT/'fixture-root').as_posix(),'/snap/bin/chromium','NEW_JOB_OUTPUT','--first']}


def trusted(path):
    for p in [*reversed(path.parents),path]:
        s=p.lstat()
        if stat.S_ISLNK(s.st_mode)or s.st_uid!=0 or s.st_mode&0o7022:
            raise RuntimeError('ROOT_OWNED_TRIAL_CODE_REQUIRED')
        if any(n in {'security.capability','system.posix_acl_access','system.posix_acl_default'}for n in os.listxattr(p,follow_symlinks=False)):
            raise RuntimeError('TRIAL_CODE_ACL_OR_CAPABILITIES')


def run():
    if sys.platform!='linux' or not sys.flags.isolated:raise RuntimeError('LINUX_ISOLATED_TRIAL_REQUIRED')
    if Path(__file__).absolute()!=ROOT/'run-local-trial.py':raise RuntimeError('MANAGED_TRIAL_PATH_REQUIRED')
    import pwd
    a=pwd.getpwnam('bartosz-browser')
    if os.geteuid()==0 or os.getuid()!=a.pw_uid or os.getgid()!=a.pw_gid or not set(os.getgroups())<={a.pw_gid}:
        raise RuntimeError('DEDICATED_NONROOT_TRIAL_UID_REQUIRED')
    if a.pw_dir!=str(HOME)or a.pw_shell!='/usr/sbin/nologin':raise RuntimeError('DEDICATED_ACCOUNT_CONTRACT')
    for name in ['run-local-trial.py','supervise.py','node','browser-check.mjs','fixture-root']:
        trusted(ROOT/name)
    h=sha256()
    with(ROOT/'node').open('rb')as f:
        while block:=f.read(1048576):h.update(block)
    if h.hexdigest()!=NODE_HASH:raise RuntimeError('TRIAL_NODE_HASH_CHANGED')
    # The owner provisions this exact account-owned jobs directory. No arbitrary
    # path or command is accepted from the executor/request.
    for p in [HOME,HOME/'snap',HOME/'snap/chromium',HOME/'snap/chromium/common',JOBS]:
        s=p.lstat()
        if not stat.S_ISDIR(s.st_mode)or s.st_uid!=a.pw_uid or s.st_gid!=a.pw_gid or stat.S_IMODE(s.st_mode)!=0o700:
            raise RuntimeError('PRIVATE_TRIAL_HOME_REQUIRED')
    job=JOBS/('trial-'+uuid.uuid4().hex);job.mkdir(mode=0o700)
    command=plan()['command'];command[command.index('--') :command.index('--')]=['--output',str(job/'resources.json')]
    command[command.index('NEW_JOB_OUTPUT')]=str(job/'browser')
    # Clear all inherited values, including tokens, LD_*, NODE_*, proxy, DBus,
    # desktop/cookies/session credentials. Snap may build its own environment.
    env={'PATH':'/usr/bin:/bin','HOME':str(HOME),'LANG':'C.UTF-8','TMPDIR':str(JOBS)}
    p=subprocess.run(command,env=env,cwd=ROOT,stdin=subprocess.DEVNULL,capture_output=True,timeout=112)
    if len(p.stdout)>2097152 or len(p.stderr)>2097152:raise RuntimeError('TRIAL_OUTPUT_LIMIT')
    return {'schema':'ote-snap-local-trial-result:1','exit_code':p.returncode,'job':str(job),
        'resource_receipt':str(job/'resources.json'),'browser_output':str(job/'browser'),
        'kernel_isolation_acceptance':'ROOT_OBSERVER_REQUIRED_NOT_CLAIMED_BY_WORKER',
        'LIVE_SOURCE_ACCESS':'BLOCKED_AUTHORIZATION','accepted':False}


def main():
    p=argparse.ArgumentParser();p.add_argument('--owner-authorized-local-trial',action='store_true');a=p.parse_args()
    value=run()if a.owner_authorized_local_trial else plan()
    print(json.dumps(value));return value.get('exit_code',0)


if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'status':'REFUSED','code':str(error)if isinstance(error,RuntimeError)else type(error).__name__,'accepted':False}));raise SystemExit(78)
