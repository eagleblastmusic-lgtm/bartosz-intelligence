"""Separate candidate plan and exact rollback; installation stays blocked."""
import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

HERE=Path(__file__).absolute().parent


def arguments():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['plan','apply','rollback'],nargs='?',default='plan')
    p.add_argument('--approved-plan-sha256');p.add_argument('--output',type=Path);return p.parse_args()


def bootstrap():
    # Standard library only: an administrator must validate imports BEFORE
    # adding the review packet to isolated Python's module search path.
    if os.name=='posix'and os.geteuid()==0:
        if not sys.flags.isolated:raise RuntimeError('ROOT_ISOLATED_ADMIN_REQUIRED')
        for path in [*reversed(HERE.parents),HERE,*HERE.iterdir()]:
            m=path.lstat()
            if stat.S_ISLNK(m.st_mode)or m.st_uid!=0 or stat.S_IMODE(m.st_mode)&0o022:
                raise RuntimeError('ROOT_OWNED_REVIEW_PACKET_REQUIRED')
            attrs=os.listxattr(path,follow_symlinks=False)
            if any(x in {'system.posix_acl_access','system.posix_acl_default','security.capability'}for x in attrs):
                raise RuntimeError('ROOT_PACKET_ACL_OR_CAPABILITIES')
    sys.path.insert(0,str(HERE))


if __name__=='__main__':
    EARLY_ARGS=arguments()
    if EARLY_ARGS.action=='apply':
        print(json.dumps({'status':'REFUSED','code':'V2_INSTALLATION_BLOCKED_NO_FORCE_PATH','accepted':False}));raise SystemExit(78)
    try:bootstrap()
    except Exception as error:
        print(json.dumps({'status':'REFUSED','code':str(error),'accepted':False}));raise SystemExit(78)

import enforced
import policy
import install

BLOCKERS=['ACTIVE_POLICY_LIBRARY_DENIAL_NOT_PROVEN','ACTIVE_POLICY_SANDBOX_COMPATIBILITY_NOT_PROVEN',
    'UNCONFINED_INCOMING_PROFILE_TRANSITION_NOT_CLOSED','DIRECT_ELF_SANDBOX_ARGV_NOT_ENFORCED',
    'LATE_DYNAMIC_LOAD_COVERAGE_NOT_OBSERVED']


def plan():
    c=enforced.validate_config(policy.load(HERE/'enforced-runtime.json'));lock=enforced.load_lock(HERE/'v2-library-lock.json')
    policy.require(enforced.digest(HERE/'v2-library-lock.json')==c['library_lock_sha256'],'V2_LOCK_HASH_CHANGED')
    enforced.validate_profile(c,lock,(HERE/(enforced.PROFILE+'.apparmor')).read_text())
    names=['enforced.py','launcher-v2.py','enforced-runtime.json','v2-library-lock.json','policy.py','assets.json',
        'v2-plan.py','v2-active-tests.py','positive.py','install.py',enforced.PROFILE+'.apparmor']
    supervisor=HERE/'supervise.py'if(HERE/'supervise.py').is_file()else HERE.parent/'supervise.py'
    value={'schema':'ote-enforced-candidate-plan:2','deployment_allowed':False,'critical_blockers':BLOCKERS,
        'old_installer_block_preserved':True,'root_runtime':c['runtime_root'],'exact_elf':c['executable'],
        'new_profile_path':c['apparmor_profile_path'],'profile_mode':'enforce','m_paths':sorted(lock['files']),
        'exec_paths':[c['executable']],'profile_sha256':enforced.digest(HERE/(enforced.PROFILE+'.apparmor')),
        'packet_sha256':{n:enforced.digest(HERE/n)for n in names},
        'future_operations_requiring_new_owner_approval':[
            'Verify unchanged root library lock, all aliases/parents/ACL/caps and backup exact pre-state',
            'Create one pinned root:988 runtime, directories0750 ELF/launcher0750 data0640; no overwrite',
            'Write one root:root0644 exact enforce profile; add only this profile with --skip-cache',
            'Validate disk integrity; run already-installed active-policy harness under supervisor768MiB',
            'On critical failure stop test processes and remove only this policy; seal runtime root-only'],
        'host_sysctl_changes':False,'services_or_accounts_added':False,'production_executor_changes':False,
        'rollback':{'requires_no_active_exact_elf':True,'exact_profile_only':c['apparmor_profile_path'],
            'runtime_retained_for_evidence_root_only':True,'no_recursive_delete':True},
        'LIBRARY_BOUNDARY_READINESS':'CANDIDATE_COMPILED_ACTIVE_POLICY_PENDING',
        'SANDBOX_DEPLOYMENT_READINESS':'BLOCKED_SECURITY_MODEL_AND_ACTIVE_ACCEPTANCE','LIVE_SOURCE_ACCESS':'BLOCKED_AUTHORIZATION'}
    value['packet_sha256']['supervise.py']=enforced.digest(supervisor)
    value['plan_sha256']=sha256(policy.canonical(value)).hexdigest();return value,c,lock


def rollback(c,lock):
    install.trusted_packet();enforced.validate_lock(lock);targets=enforced.rollback_targets(c)
    policy.require(not install.browsers(c['executable']),'ACTIVE_BROWSER_MUST_BE_STOPPED')
    root=Path(c['runtime_root']);root.chmod(0o700)
    policy.require(not install.browsers(c['executable']),'ACTIVE_BROWSER_MUST_BE_STOPPED')
    name=c['apparmor_profile_name'];path=Path(c['apparmor_profile_path'])
    before=install.settings()
    # Preserve even a corrupted profile before revoking this exact named policy.
    # Root-only runtime is retained, not recursively removed or revalidated.
    if targets['profile_file_present']:
        backup=root/('rollback-profile-v2-'+targets['original_profile_sha256']+'.apparmor')
        if backup.exists():
            enforced.check_metadata(enforced.metadata(backup))
            policy.require(enforced.digest(backup)==targets['original_profile_sha256'],'V2_ROLLBACK_BACKUP_CHANGED')
        else:
            with backup.open('xb')as f:f.write(path.read_bytes())
            backup.chmod(0o600)
    already_removed=not install.loaded(name)
    if not already_removed:
        p=subprocess.run(['/usr/sbin/apparmor_parser','--remove','--skip-cache'],input=enforced.profile_text(c,lock).encode(),
            capture_output=True,timeout=15,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'})
        policy.require(p.returncode==0 and not install.loaded(name),'V2_ROLLBACK_KERNEL_REMOVE_FAILED')
    if targets['profile_file_present']:path.unlink()
    policy.require(install.settings()==before,'GLOBAL_SETTINGS_DRIFT')
    return {'status':'V2_REVOKED','retained_runtime_mode':'0700','profile_removed':True,
        'global_settings_unchanged':True,'pre_revocation':targets,'kernel_profile_already_removed':already_removed}


def main():
    args=EARLY_ARGS if __name__=='__main__'else arguments()
    # No flag/hash can authorize apply in this research revision.
    if args.action=='apply':raise policy.Rejected('V2_INSTALLATION_BLOCKED_NO_FORCE_PATH')
    if args.action=='rollback':install.trusted_packet()
    result,c,lock=plan()
    if args.action=='rollback':
        policy.require(args.approved_plan_sha256==result['plan_sha256'],'V2_EXACT_ROLLBACK_PLAN_REQUIRED');result=rollback(c,lock)
    if args.output:
        data=(json.dumps(result,indent=2)+'\n').encode()
        if os.name=='posix'and os.geteuid()==0:
            parent=args.output.absolute().parent;boundary=enforced.chain(parent)
            policy.require(boundary['resolved']==str(parent),'V2_RESULT_PARENT_ALIAS')
            directory=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
            try:
                fd=os.open(args.output.name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=directory)
                with os.fdopen(fd,'wb')as f:f.write(data)
            finally:os.close(directory)
        else:
            args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_bytes(data)
    print(json.dumps(result))


if __name__=='__main__':
    try:main()
    except Exception as e:
        print(json.dumps({'status':'REFUSED','code':str(e)if isinstance(e,policy.Rejected)else type(e).__name__,'accepted':False}));raise SystemExit(78)
