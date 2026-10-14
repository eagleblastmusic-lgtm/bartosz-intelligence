"""Offline contracts, harmless CDP fixture and native unit syntax; no Snap start."""
import argparse
import base64
import gzip
from hashlib import sha256
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[3]
sys.path.insert(0,str(HERE.parent))
from diagnose import ssh

REMOTE=r'''
import base64,hashlib,io,json,os,pathlib,resource,subprocess,sys,tarfile,tempfile,time
blob=base64.b64decode(PACKET);assert hashlib.sha256(blob).hexdigest()==PACKET_SHA
def boundary():
 return {'profiles_sha256':hashlib.sha256(pathlib.Path('/sys/kernel/security/apparmor/profiles').read_bytes()).hexdigest(),
  'sysctl':{n:pathlib.Path(n).read_text().strip()for n in ['/proc/sys/kernel/apparmor_restrict_unprivileged_userns','/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined']},
  'snap_state_sha256':hashlib.sha256(pathlib.Path('/var/lib/snapd/state.json').read_bytes()).hexdigest(),
  'chromium_entrypoint_absent':not pathlib.Path('/snap/bin/chromium').exists()}
before=boundary();started=time.monotonic()
result={'schema':'ote-isolation-architecture-oracle-offline:1','source_sha256':SOURCE_HASHES,
 'snap_executions':0,'chromium_executions':0,'unit_starts':0,'host_security_changes':0,'accepted':False}
env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'}
with tempfile.TemporaryDirectory(prefix='ote-architecture-offline-')as folder:
 root=pathlib.Path(folder)
 with tarfile.open(fileobj=io.BytesIO(blob),mode='r:gz')as t:t.extractall(root,filter='data')
 here=root/'tools/transcript-engine/sandbox/architecture'
 sys.path.insert(0,str(here));import candidate
 c=json.loads((here/'candidate.json').read_text());units=candidate.render(c,60000)
 for name,body in units.items():(root/name).write_text(body)
 p=subprocess.run(['/usr/bin/python3','-B',str(here/'contracts.py')],cwd=root,capture_output=True,timeout=15,env=env)
 result['contracts']={'exit_code':p.returncode,'receipt':json.loads(p.stdout),'stderr':p.stderr.decode()[-4096:]}
 p=subprocess.run(['/usr/bin/systemd-analyze','verify','--man=no',*[str(root/name)for name in units]],capture_output=True,timeout=15,env=env)
 result['unit_syntax']={'exit_code':p.returncode,'stderr':p.stderr.decode()[:8192],'service_activated':False,
  'rendered_files':{name:hashlib.sha256(body.encode()).hexdigest()for name,body in units.items()}}
 # Node runtime belongs to ubuntu, not root. Run the harmless protocol fixture
 # under that same existing UID, never execute mutable uid1001 code as root.
 for p in root.rglob('*'):os.chown(p,1001,1001)
 os.chown(root,1001,1001)
 p=subprocess.run(['/opt/bartosz-intelligence/runtime/node-24.21.0/bin/node',str(here/'cdp-contract.mjs'),
  '--root',str(root),'--client-bundle',str(root/'client-contract.mjs'),'--output',str(root/'cdp-out')],
  user=1001,group=1001,extra_groups=[],cwd=root,env=env,capture_output=True,timeout=30,start_new_session=True)
 result['cdp_client']={'exit_code':p.returncode,'receipt':json.loads(p.stdout)if p.stdout else None,'stderr':p.stderr.decode()[-8192:]}
result['temporary_removed']=not root.exists();result['before']=before;result['after']=boundary()
result['boundary_unchanged']=before==result['after'];result['elapsed_ms']=round((time.monotonic()-started)*1000)
result['max_child_rss_kib']=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
result['pass']=result['contracts']['exit_code']==result['unit_syntax']['exit_code']==result['cdp_client']['exit_code']==0 and result['boundary_unchanged']and result['temporary_removed']
print(json.dumps(result))
'''


def main():
    p=argparse.ArgumentParser();p.add_argument('--key',type=Path,required=True);p.add_argument('--client-bundle',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    if a.output.exists():raise SystemExit('NEW_OFFLINE_OUTPUT_REQUIRED')
    names=['candidate.py','candidate.json','contracts.py','run-local-trial.py','cdp-contract.mjs','harmless-cdp-fixture.mjs']
    files={(HERE/n).relative_to(ROOT).as_posix():(HERE/n).read_bytes()for n in names}
    for n in ['install.py','policy.py','runtime.json','bartosz-ote-chromium-153_0_8010_12.apparmor']:
        files[(HERE.parent/n).relative_to(ROOT).as_posix()]=(HERE.parent/n).read_bytes()
    for n in ['tools/firefox-transcript-diagnostic-2026-10-12/evidence/aircAruvnKk.reference.json',
              'tools/firefox-transcript-v0.4.2/candidate-v0.4.2/panel-reader.js']:
        files[n]=(ROOT/n).read_bytes()
    files['client-contract.mjs']=a.client_bundle.read_bytes();stream=io.BytesIO()
    with gzip.GzipFile(fileobj=stream,mode='wb',mtime=0,filename='')as gz:
        with tarfile.open(fileobj=gz,mode='w')as tar:
            for n,b in sorted(files.items()):
                e=tarfile.TarInfo(n);e.size=len(b);e.mode=0o600;tar.addfile(e,io.BytesIO(b))
    blob=stream.getvalue();source='PACKET='+repr(base64.b64encode(blob).decode())+'\nPACKET_SHA='+repr(sha256(blob).hexdigest())+'\nSOURCE_HASHES='+repr({n:sha256(b).hexdigest()for n,b in files.items()})+'\n'+REMOTE
    command=ssh(a.key);command[-1]='env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C /usr/bin/python3 -I -'
    run=subprocess.run(command,input=source.encode(),capture_output=True,timeout=70)
    if run.returncode:raise SystemExit('OFFLINE_ARCHITECTURE_FAILED:'+run.stderr.decode()[-4096:])
    value=json.loads(run.stdout);a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(value,indent=2)+'\n')
    print(json.dumps({k:v for k,v in value.items()if k not in {'source_sha256','before','after'}}));return 0 if value['pass']else 2


if __name__=='__main__':raise SystemExit(main())
