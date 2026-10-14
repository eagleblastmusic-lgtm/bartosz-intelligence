"""SSH transport for the explicitly approved one-off Snap trial packet."""
import argparse
import base64
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[3]
sys.path.insert(0,str(HERE.parent))
from diagnose import ssh
REMOTE_ROOT='/root/bartosz-ote-snap-trial-20261014'


def main():
    p=argparse.ArgumentParser();p.add_argument('phase',choices=['stage','update','update_engine','preflight','install','finish_install','setup','test','native','native_fix','native_probe','native_mit','publisher_github','publisher_mit','memory_check','stop','retain','rollback','collect','state'])
    p.add_argument('--key',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--engine-bundle',type=Path);p.add_argument('--publisher-configs',type=Path);mode=p.add_mutually_exclusive_group();mode.add_argument('--cgroup-trial',action='store_true');mode.add_argument('--deployment',action='store_true');a=p.parse_args()
    remote_root='/root/bartosz-ote-snap-cgroup-20261014'if a.cgroup_trial else REMOTE_ROOT
    if a.deployment:remote_root='/root/bartosz-ote-chromium-deployment-20261014'
    command=ssh(a.key)
    if a.phase=='stage':
        files={'snap-trial.py':(HERE/'snap-trial.py').read_bytes(),'host_state.py':(HERE.parent/'host-state.py').read_bytes(),
            'runtime.json':(HERE.parent/'runtime.json').read_bytes()}
        packet={n:(ROOT/'.local/browser-isolation/trial-bundle'/n).read_bytes()for n in ['browser-check.mjs','dom-reader.js']}
        packet['supervise.py']=(HERE.parents[1]/'supervise.py').read_bytes()
        packet['diagnostic-run.mjs']=(HERE/'diagnostic-run.mjs').read_bytes()
        if a.cgroup_trial or a.deployment:packet['snap-entry.py']=(HERE/'snap-entry.py').read_bytes()
        if a.deployment:
            approved=json.loads((ROOT/'docs/verification/oracle/2026-10-14/chromium-snap-cgroup-trial/snaps-installed.json').read_text())
            names={'chromium','core24','core26','gnome-46-2404','mesa-2404','gtk-common-themes','cups','bare'}
            files['approved-snaps.json']=(json.dumps({n:str(approved[n]['current'])for n in sorted(names)})+'\n').encode()
            packet['transcript-engine.mjs']=(ROOT/'.local/chromium-deployment/bundle/transcript-engine.mjs').read_bytes()
            config={'schema':'ote-source:1','diagnostic_video_id':'aircAruvnKk',
                'browser_executable':'/opt/bartosz-intelligence/browser-runtime/snap-entry.py','sandbox':True}
            packet['native-source.json']=(json.dumps(config,ensure_ascii=False,indent=2)+'\n').encode()
        packet['fixture-root/tools/firefox-transcript-diagnostic-2026-10-12/evidence/aircAruvnKk.reference.json']=(ROOT/'tools/firefox-transcript-diagnostic-2026-10-12/evidence/aircAruvnKk.reference.json').read_bytes()
        files['packet-files.json']=(json.dumps({n:sha256(b).hexdigest()for n,b in packet.items()})+'\n').encode()
        files.update({'packet/'+n:b for n,b in packet.items()})
        source='REMOTE_ROOT='+repr(remote_root)+'\nFILES='+repr({n:base64.b64encode(b).decode()for n,b in files.items()})+'\n'+r'''
import base64,json,os,pathlib,stat
root=pathlib.Path(REMOTE_ROOT)
assert not root.exists() and os.geteuid()==0
root.mkdir(mode=0o700)
for name,data in FILES.items():
 p=root/name;assert p.is_relative_to(root) and '..'not in p.parts
 p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 with p.open('xb')as f:f.write(base64.b64decode(data))
 p.chmod(0o600)
print(json.dumps({'stage':'PASS','root':str(root),'files':len(FILES)}))
'''
        command[-1]='env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C /usr/bin/python3 -I -'
        run=subprocess.run(command,input=source.encode(),capture_output=True,timeout=45)
    elif a.phase=='update':
        body=(HERE/'snap-trial.py').read_bytes()
        source='REMOTE_ROOT='+repr(remote_root)+'\nBODY='+repr(base64.b64encode(body).decode())+'\n'+r'''
import base64,hashlib,json,pathlib,os
root=pathlib.Path(REMOTE_ROOT);p=root/'snap-trial.py'
assert root.stat().st_uid==0 and not root.is_symlink() and os.geteuid()==0
before=hashlib.sha256(p.read_bytes()).hexdigest()
backup=root/('snap-trial.before-'+before+'.py')
if not backup.exists():backup.write_bytes(p.read_bytes());backup.chmod(0o600)
p.write_bytes(base64.b64decode(BODY));p.chmod(0o600)
print(json.dumps({'update':'PASS','before_sha256':before,'after_sha256':hashlib.sha256(p.read_bytes()).hexdigest()}))
'''
        command[-1]='env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C /usr/bin/python3 -I -'
        run=subprocess.run(command,input=source.encode(),capture_output=True,timeout=30)
    elif a.phase=='update_engine':
        assert a.deployment and a.engine_bundle
        body=a.engine_bundle.read_bytes();assert len(body)<1048576
        configs={n:json.loads((a.publisher_configs/('publisher-'+n+'.json')).read_text())for n in ['github','mit']}if a.publisher_configs else{}
        source='CONFIGS='+repr(configs)+'\nBODY='+repr(base64.b64encode(body).decode())+'\n'+r'''
import base64,hashlib,json,pathlib,pwd,os
root=pathlib.Path('/root/bartosz-ote-chromium-deployment-20261014')
p=pathlib.Path('/opt/bartosz-intelligence/browser-runtime/transcript-engine.mjs')
assert os.geteuid()==0 and p.resolve()==p and p.stat().st_uid==0 and not p.stat().st_mode&0o022
uid=pwd.getpwnam('bartosz-browser').pw_uid
assert not any(x.name.isdigit()and x.stat().st_uid==uid for x in pathlib.Path('/proc').iterdir())
before=hashlib.sha256(p.read_bytes()).hexdigest();backup=root/('transcript-engine.before-'+before+'.mjs')
if not backup.exists():backup.write_bytes(p.read_bytes());backup.chmod(0o600)
p.write_bytes(base64.b64decode(BODY));p.chmod(0o644)
for name,value in CONFIGS.items():
 assert name in {'github','mit'} and value['schema']=='ote-source:1'
 cp=p.parent/('publisher-'+name+'.json');assert not cp.is_symlink()
 cp.write_text(json.dumps(value)+'\n');cp.chmod(0o644)
result={'before_sha256':before,'after_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'production_release_touched':False}
(root/('engine-update-'+result['after_sha256']+'.json')).write_text(json.dumps(result)+'\n')
print(json.dumps(result))
'''
        command[-1]='env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C /usr/bin/python3 -I -'
        run=subprocess.run(command,input=source.encode(),capture_output=True,timeout=30)
    elif a.phase=='collect':
        source='REMOTE_ROOT='+repr(remote_root)+'\n'+r'''
import json,pathlib,os
root=pathlib.Path(REMOTE_ROOT);rows={}
for p in root.glob('*.json'):
 assert p.stat().st_size<8388608 and not p.is_symlink() and p.stat().st_uid==0
 rows[p.name]=json.loads(p.read_text())
print(json.dumps(rows))
'''
        command[-1]='env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C /usr/bin/python3 -I -'
        run=subprocess.run(command,input=source.encode(),capture_output=True,timeout=40)
    else:
        command[-1]='env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -I '+remote_root+'/snap-trial.py '+a.phase+' --owner-authorized'+(' --deployment'if a.deployment else' --cgroup-trial'if a.cgroup_trial else'')
        run=subprocess.run(command,capture_output=True,timeout=640 if a.phase=='install'else 400 if a.phase=='rollback'else 140)
    if not run.stdout:
        a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps({'exit_code':run.returncode,'stderr':run.stderr.decode()[-8192:]},indent=2))
        raise SystemExit('REMOTE_PHASE_NO_RECEIPT:'+run.stderr.decode()[-2048:])
    value=json.loads(run.stdout);a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(value,indent=2)+'\n')
    print(json.dumps({'phase':a.phase,'remote_exit':run.returncode,'receipt':str(a.output),'status':value.get('status',value.get('stage')),
        'code':value.get('code'),'fields':list(value)if a.phase=='collect'else None}));return run.returncode


if __name__=='__main__':raise SystemExit(main())
