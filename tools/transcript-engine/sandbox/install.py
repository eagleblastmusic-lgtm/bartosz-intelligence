"""Plan by default. apply/rollback require owner approval and a root-owned packet.

This script is prepared locally; it must not be invoked to change the host until
the owner approves the exact plan. It never starts Chromium or touches sysctl,
systemd, SSH, network, IAM, D1 or the production executor.
"""
import argparse
import errno
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))


def deployment_blockers(c):
    """The prepared exception does not force callers through the clean launcher.

    Root ownership prevents overwrites, but direct nonroot ELF execution can
    select caller-owned libraries. Clearing this blocker requires a reviewed
    enforced mapping/exec boundary, not another environment-filter option.
    """
    import policy
    policy.validate_profile(c,(HERE/(c['apparmor_profile_name']+'.apparmor')).read_text(encoding='utf-8'))
    return ['DIRECT_ELF_LIBRARY_BOUNDARY_UNENFORCED']


def trusted_packet():
    if os.name!='posix' or os.geteuid()!=0 or not sys.flags.isolated:
        raise RuntimeError('ROOT_ISOLATED_ADMIN_REQUIRED')
    for p in list(HERE.parents)+[HERE]+list(HERE.iterdir()):
        if p.name=='__pycache__':continue
        s=p.lstat()
        if p.is_symlink() or s.st_uid!=0 or stat.S_IMODE(s.st_mode)&0o022:
            raise RuntimeError('ROOT_OWNED_REVIEW_PACKET_REQUIRED')


def plan(c,assets):
    import policy
    policy.validate_config(c);policy.validate_assets(c,assets)
    files=['runtime.json','assets.json','launcher.py','policy.py','prepare.py','install.py',c['apparmor_profile_name']+'.apparmor']
    policy.validate_profile(c,(HERE/files[-1]).read_text(encoding='utf-8'))
    return {'schema':'ote-sandbox-change-plan:1','account':c['account'],'uid':c['uid'],'gid':c['gid'],
        'runtime_root':c['runtime_root'],'profile_path':c['apparmor_profile_path'],
        'profile_name':c['apparmor_profile_name'],'archive_sha256':c['archive_sha256'],
        'asset_files':len(assets['files']),'packet_hashes':{n:sha256((HERE/n).read_bytes()).hexdigest()for n in files},
        'operations':[
            'Create root-owned versioned browser directory; dirs 0750 root:988, data 0640, launcher/executable 0750',
            'Install exactly one root:root 0644 AppArmor file for that exact executable',
            'Load only that new profile with apparmor_parser --add --skip-cache',
            'Record integrity/approval receipt; no browser or service is started'],
        'rollback':['Refuse while managed browser processes exist','Revoke group access to version directory (0700)',
                    'Remove only this AppArmor profile from kernel and its exact file; retain sealed runtime for evidence'],
        'changes_sysctl':False,'changes_services':False,'setuid_or_file_capabilities':False,'owner_approval_required':True,
        'deployment_allowed':False,'critical_blockers':deployment_blockers(c)}


def loaded(name):
    profiles=Path('/sys/kernel/security/apparmor/profiles').read_text()
    return any(s.startswith(name+' ') for s in profiles.splitlines())


def browsers(executable):
    found=[]
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():continue
        try:
            target=os.readlink(p/'exe').removesuffix(' (deleted)')
            if target==executable:found.append(int(p.name))
        except OSError as e:
            if e.errno in {errno.ENOENT,errno.ESRCH}:continue
            # Incomplete /proc visibility must not authorize policy removal.
            raise RuntimeError('PROCESS_VISIBILITY_REQUIRED')from e
    return found


def settings():
    return {p:Path(p).read_text().strip() for p in [
        '/proc/sys/kernel/unprivileged_userns_clone','/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
        '/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined','/proc/sys/user/max_user_namespaces']}


def parser_operation(c,operation):
    import policy
    run=subprocess.run(['/usr/sbin/apparmor_parser',operation,'--skip-cache'],
        input=policy.profile_text(c).encode(),capture_output=True,timeout=15,
        env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'})
    policy.require(run.returncode==0,'PROFILE_KERNEL_OPERATION_FAILED')


def apply(c,assets,archive,approval):
    import policy,prepare
    trusted_packet()
    policy.require(not deployment_blockers(c),'DIRECT_ELF_LIBRARY_BOUNDARY_UNENFORCED')
    policy.account_matches(c)
    root=Path(c['runtime_root']);profile=Path(c['apparmor_profile_path']);base=root.parent
    policy.require(not root.exists() and not profile.exists() and not loaded(c['apparmor_profile_name']),'EXISTING_VERSION_OR_PROFILE_REQUIRES_REVIEW')
    policy.secure_ancestors(base)
    policy.secure_ancestors(profile)
    before=settings()
    blob=archive.read_bytes()
    actual=prepare.inspect_archive(c,blob)
    policy.require(actual==assets,'ARCHIVE_ASSET_MANIFEST_MISMATCH')
    if not base.exists():
        base.mkdir(mode=0o755);os.chown(base,0,0)
    policy.check_meta(policy.metadata(base),directory=True,gid=0,mode=0o755)
    with tempfile.TemporaryDirectory(prefix='.ote-browser-stage-',dir=base) as temporary:
        stage=Path(temporary)
        policy.require(stage.parent==base and str(base)==policy.BASE,'STAGE_BOUNDARY')
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            for name,row in assets['files'].items():
                p=stage/name;p.parent.mkdir(parents=True,exist_ok=True)
                p.write_bytes(z.read('chrome-headless-shell-linux-arm64/'+name))
        for name in ['runtime.json','assets.json','launcher.py','policy.py']:
            (stage/name).write_bytes((HERE/name).read_bytes())
        for p in stage.rglob('*'):
            os.chown(p,0,c['gid'])
            p.chmod(0o750 if p.is_dir() or p.name in {'chrome-headless-shell','launcher.py'} else 0o640)
        os.chown(stage,0,c['gid']);stage.chmod(0o750)
        stage.rename(root)
        # TemporaryDirectory cleanup sees the old now-absent staging path only.
    try:
        policy.validate_runtime(c,check_profile=False)
        # New filename only; exclusive creation refuses replacement of any policy.
        with profile.open('x',encoding='utf-8') as f:f.write(policy.profile_text(c))
        os.chown(profile,0,0);profile.chmod(0o644)
        parser_operation(c,'--add')
        policy.require(loaded(c['apparmor_profile_name']),'PROFILE_NOT_LOADED')
        policy.require(settings()==before,'GLOBAL_SETTINGS_CHANGED_EXTERNALLY')
        policy.validate_runtime(c)
    except Exception:
        # Deny new execution; keep evidence and exact policy for explicit rollback.
        root.chmod(0o700)
        raise
    receipt={'schema':'ote-sandbox-install:1','status':'INSTALLED_AWAITING_POSITIVE_PROBE',
        'approved_plan_sha256':approval,'settings_before':before,'settings_after':settings(),
        'browser_started':False,'services_started':0,'accepted':False}
    (root/'install-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
    os.chown(root/'install-receipt.json',0,c['gid']);(root/'install-receipt.json').chmod(0o640)
    return receipt


def rollback(c,approval):
    import policy
    trusted_packet()
    root=Path(c['runtime_root']);profile=Path(c['apparmor_profile_path'])
    before=settings()
    policy.validate_runtime(c,check_profile=False,allow_inactive=True)
    policy.secure_ancestors(profile)
    policy.require(not browsers(c['executable']),'ACTIVE_BROWSER_MUST_BE_STOPPED')
    if profile.exists():
        policy.check_meta(policy.metadata(profile),gid=0,mode=0o644)
        policy.validate_profile(c,profile.read_text(encoding='utf-8'))
    root.chmod(0o700)
    policy.require(not browsers(c['executable']),'ACTIVE_BROWSER_MUST_BE_STOPPED')
    if loaded(c['apparmor_profile_name']):parser_operation(c,'--remove')
    policy.require(not loaded(c['apparmor_profile_name']),'PROFILE_STILL_LOADED')
    if profile.exists():profile.unlink()
    policy.require(settings()==before,'GLOBAL_SETTINGS_CHANGED_EXTERNALLY')
    receipt={'schema':'ote-sandbox-rollback:1','status':'REVOKED_PROFILE_AND_RUNTIME_ACCESS',
        'approved_plan_sha256':approval,'runtime_retained_root_only':True,'global_settings_unchanged':True}
    (root/'rollback.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
    os.chown(root/'rollback.json',0,c['gid']);(root/'rollback.json').chmod(0o640)
    return receipt


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',nargs='?',choices=['plan','apply','rollback'],default='plan')
    parser.add_argument('--approved-plan-sha256')
    parser.add_argument('--archive',type=Path)
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    if args.action!='plan':trusted_packet()
    import policy
    c=policy.load(HERE/'runtime.json');assets=policy.load(HERE/'assets.json')
    proposal=plan(c,assets);fingerprint=sha256(policy.canonical(proposal)).hexdigest()
    if args.action=='plan':
        result={**proposal,'plan_sha256':fingerprint,'SANDBOX_READINESS':'BLOCKED_PREFLIGHT_LIBRARY_BOUNDARY',
            'LIVE_SOURCE_ACCESS':'BLOCKED_AUTHORIZATION','host_changes':0}
    else:
        policy.require(args.approved_plan_sha256==fingerprint,'EXACT_OWNER_APPROVED_PLAN_REQUIRED')
        if args.action=='apply':
            policy.require(args.archive is not None and args.archive.stat().st_size<256*1024*1024,'PINNED_ARCHIVE_REQUIRED')
            result=apply(c,assets,args.archive,fingerprint)
        else:result=rollback(c,fingerprint)
    if args.output:
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result))


if __name__=='__main__':
    try:main()
    except Exception as e:
        code=str(e) if str(e).replace('_','').isalnum() else 'SANDBOX_ADMIN_ACTION_FAILED'
        print(json.dumps({'status':'REFUSED','code':code,'accepted':False}));raise SystemExit(78)
