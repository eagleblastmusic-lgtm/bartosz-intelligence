"""Validate/render local trial configuration. No installation/activation function."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import sys

HERE=Path(__file__).resolve().parent


class Rejected(RuntimeError):pass


def validate(c):
    # This is a single concrete candidate, not an open-ended command generator.
    baseline=json.loads((HERE/'candidate.json').read_text())
    if c!=baseline:raise Rejected('EXACT_REVIEWED_CANDIDATE_REQUIRED')
    if c['limits']['memory_max_mib']!=768 or c['acceptance']['accepted'] or c['deployment_allowed']:
        raise Rejected('CANDIDATE_CANNOT_CLAIM_ACTIVE_ACCEPTANCE')
    return c


def render(c,uid):
    validate(c)
    if type(uid)is not int or not 1000<=uid<=60000:raise Rejected('NEW_DEDICATED_UID_REQUIRED')
    slice_name=f'user-{uid}.slice'
    limits='MemoryAccounting=yes\nCPUAccounting=yes\nTasksAccounting=yes\nMemoryHigh=640M\nMemoryMax=768M\nMemorySwapMax=0\nCPUQuota=50%\nTasksMax=256\n'
    slice_text='[Unit]\nDescription=Bartosz isolated browser account resource boundary\n\n[Slice]\n'+limits
    # PrivateNetwork survives only if snap-confine preserves the NET namespace.
    # No NNP/cap bounding/seccomp/mount directives before the supported helper.
    service='''[Unit]
Description=Bartosz one-shot local Chromium Snap acceptance trial
After=snapd.service
Requires=snapd.service

[Service]
Type=exec
User=bartosz-browser
Group=bartosz-browser
UMask=0077
Slice='''+slice_name+'''
PrivateNetwork=yes
Environment=HOME=/home/bartosz-browser
Environment=TMPDIR=/home/bartosz-browser/snap/chromium/common/jobs
WorkingDirectory=/opt/bartosz-intelligence/browser-trial
ExecStart=/usr/bin/python3 -I /opt/bartosz-intelligence/browser-trial/run-local-trial.py --owner-authorized-local-trial
RuntimeMaxSec=100s
TimeoutStopSec=10s
KillMode=control-group
Restart=no
'''+limits
    return {slice_name:slice_text,'bartosz-browser-local-trial.service':service}


def proposal(c):
    validate(c)
    files={p.name:sha256(p.read_bytes()).hexdigest()for p in sorted(HERE.iterdir())if p.is_file()}
    return {'schema':'ote-browser-isolation-plan:1','architecture':c['architecture'],'deployment_allowed':False,
        'prepared_files_sha256':files,'candidate_revision':c['runtime']['candidate_revision'],
        'installation_implemented':False,'v2_installer_remains_blocked':True,
        'exact_host_changes_requiring_new_owner_approval':[
            'Install Chromium latest/stable approved revision plus six reviewed runtime/content/base dependencies; verify assertions and actual dependency delta',
            'Record then disable trial-unneeded CUPS/Mesa service apps introduced by install; never change pre-existing services',
            'Create one nologin browser UID/group/home0700 without executor groups or sudo',
            'Copy verified Node to new root-owned trial code root; never modify existing uid1001-owned Node or executor release',
            'Provision one root-owned user-UID.slice drop-in resource boundary and one disabled local-trial unit',
            'Reload systemd unit files only after approval; manually start one PrivateNetwork local trial without enable or production',
            'Run root read-only observer; stop entire dedicated UID branch and verify no surviving processes or temporary profiles'],
        'global_sysctl_changes':False,'custom_apparmor_profile':False,'network_live_allowed':False,
        'critical_active_gates':['CDP_FD3_FD4','CHROMIUM_RENDERER_SANDBOX','NET_NAMESPACE_PRESERVED',
            'USER_SLICE_LIMITS_EFFECTIVE','PRODUCTION_SECRETS_DAC_CANARY_DENIED','CLEANUP_ALL_UID_PROCESSES','768_MIB_BUDGET'],
        'BROWSER_ISOLATION_ARCHITECTURE':c['BROWSER_ISOLATION_ARCHITECTURE'],'accepted':False}


def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['plan','render','apply'],default='plan',nargs='?')
    p.add_argument('--uid',type=int);p.add_argument('--output',type=Path);a=p.parse_args()
    if a.action=='apply':raise Rejected('INSTALLATION_NOT_AUTHORIZED_OR_IMPLEMENTED')
    c=json.loads((HERE/'candidate.json').read_text())
    if a.action=='render':
        if not a.output or a.output.exists():raise Rejected('NEW_LOCAL_RENDER_DIRECTORY_REQUIRED')
        files=render(c,a.uid);a.output.mkdir(parents=True)
        for name,body in files.items():(a.output/name).write_text(body,newline='\n')
        value={'rendered':list(files),'deployment_allowed':False,'accepted':False}
    else:
        value=proposal(c)
        if a.output:
            if a.output.exists():raise Rejected('NEW_LOCAL_PLAN_FILE_REQUIRED')
            a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(value,indent=2)+'\n')
    print(json.dumps(value))


if __name__=='__main__':
    try:main()
    except Rejected as e:
        print(json.dumps({'status':'REFUSED','code':str(e),'accepted':False}));sys.exit(78)
