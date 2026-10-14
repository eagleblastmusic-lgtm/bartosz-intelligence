"""Transfer security contracts only; compile AA without load/cache; no browser."""
import argparse
import base64
import gzip
from hashlib import sha256
import io
import json
from pathlib import Path
import subprocess
import tarfile
from diagnose import ssh

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
REMOTE=r'''
import base64,hashlib,io,json,os,pathlib,platform,resource,subprocess,tarfile,tempfile,time
blob=base64.b64decode(PACKET)
assert hashlib.sha256(blob).hexdigest()==PACKET_SHA
assert os.geteuid()!=0
def boundary():
    paths=['/proc/sys/kernel/unprivileged_userns_clone','/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
        '/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined','/proc/sys/user/max_user_namespaces',
        '/etc/apparmor.d/chrome','/etc/apparmor.d/unprivileged_userns',
        '/etc/apparmor.d/bartosz-ote-chromium-153_0_8010_12']
    return {p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest() if pathlib.Path(p).exists() else 'ABSENT' for p in paths}
before=boundary();started=time.monotonic()
result={'schema':'ote-sandbox-oracle-offline:1','platform':platform.platform(),'machine':platform.machine(),
    'uid':os.geteuid(),'packet_sha256':PACKET_SHA,'browser_executions':0,'host_security_changes':0,'source_requests':0}
with tempfile.TemporaryDirectory(prefix='ote-sandbox-contracts-') as temporary:
    root=pathlib.Path(temporary)
    assert root.parent==pathlib.Path('/tmp')
    with tarfile.open(fileobj=io.BytesIO(blob),mode='r:gz') as tar:tar.extractall(root,filter='data')
    env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1','PYTHONNOUSERSITE':'1'}
    def run(name,args,expected=0,parse=True):
        t=time.monotonic()
        p=subprocess.run(args,cwd=root,env=env,capture_output=True,timeout=30)
        item={'exit_code':p.returncode,'expected_exit_code':expected,'pass':p.returncode==expected,
            'elapsed_ms':round((time.monotonic()-t)*1000),'stderr_sha256':hashlib.sha256(p.stderr).hexdigest()}
        if parse and p.returncode==expected:item['receipt']=json.loads(p.stdout)
        elif p.returncode!=expected:item['diagnostic']=p.stderr.decode('utf-8','replace')[-8192:]
        result[name]=item
    python='/usr/bin/python3'
    run('contracts',[python,'-B',str(root/'contracts.py'),str(root/'contracts-result.json')])
    run('positive_gate',[python,'-B',str(root/'positive.py'),'--output',str(root/'positive-gate.json')])
    run('environment',['/opt/bartosz-intelligence/runtime/node-24.21.0/bin/node','--max-old-space-size=128',str(root/'environment-check.mjs')])
    text=(root/'bartosz-ote-chromium-153_0_8010_12.apparmor').read_bytes()
    result['apparmor_compile']={}
    for name,source,expected in [('exact_profile',text,True),('invalid_syntax',text.replace(b'  userns,',b'  userns INVALID_TOKEN,'),False)]:
        command=['/usr/sbin/apparmor_parser','--skip-kernel-load','--skip-cache','--stdout']
        p=subprocess.run(command,input=source,cwd=root,env=env,capture_output=True,timeout=15)
        result['apparmor_compile'][name]={'command':command,'exit_code':p.returncode,
            'pass':(p.returncode==0 and len(p.stdout)>0)if expected else p.returncode!=0,
            'compiled_bytes':len(p.stdout),'compiled_sha256':hashlib.sha256(p.stdout).hexdigest(),
            'stderr':p.stderr.decode('utf-8','replace')[:2048],'source_sha256':hashlib.sha256(source).hexdigest(),
            'kernel_load':False,'cache_writes':False}
result['temporary_directory_removed']=not root.exists()
result['boundary_before']=before;result['boundary_after']=boundary();result['boundary_unchanged']=before==result['boundary_after']
result['elapsed_ms']=round((time.monotonic()-started)*1000)
result['max_rss_children_kib']=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
result['pass']=all(result[k]['pass'] for k in ['contracts','positive_gate','environment']) and all(v['pass']for v in result['apparmor_compile'].values()) and result['boundary_unchanged']
result['SANDBOX_READINESS']='BLOCKED_PREFLIGHT_LIBRARY_BOUNDARY'
result['LIVE_SOURCE_ACCESS']='BLOCKED_AUTHORIZATION';result['accepted']=False
print(json.dumps(result))
'''


def main():
    p=argparse.ArgumentParser();p.add_argument('--key',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    args=p.parse_args()
    names=['contracts.py','policy.py','prepare.py','install.py','launcher.py','positive.py','runtime.json','assets.json',
        'bartosz-ote-chromium-153_0_8010_12.apparmor']
    files={name:(HERE/name).read_bytes()for name in names}
    files['environment-check.mjs']=(ROOT/'.local/chromium-sandbox/environment-check.mjs').read_bytes()
    stream=io.BytesIO()
    with gzip.GzipFile(fileobj=stream,mode='wb',mtime=0,filename='')as zipped:
        with tarfile.open(fileobj=zipped,mode='w')as tar:
            for name,data in sorted(files.items()):
                entry=tarfile.TarInfo(name);entry.size=len(data);entry.mode=0o600;tar.addfile(entry,io.BytesIO(data))
    blob=stream.getvalue()
    remote=f'PACKET={base64.b64encode(blob).decode()!r}\nPACKET_SHA={sha256(blob).hexdigest()!r}\n'+REMOTE
    run=subprocess.run(ssh(args.key),input=remote.encode(),capture_output=True,timeout=90)
    if run.returncode:raise SystemExit('OFFLINE_ORACLE_FAILED_'+sha256(run.stderr).hexdigest())
    result=json.loads(run.stdout);result['input_hashes']={name:sha256(data).hexdigest()for name,data in sorted(files.items())}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items()if k not in {'input_hashes','boundary_before','boundary_after'}}))
    return 0 if result['pass']else 2


if __name__=='__main__':raise SystemExit(main())
