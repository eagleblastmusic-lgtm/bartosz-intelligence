"""Offline v2 contracts + native parser + current library verification. No load."""
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
REMOTE=r'''
import base64,hashlib,io,json,os,pathlib,platform,resource,subprocess,sys,tarfile,tempfile,time
blob=base64.b64decode(PACKET);assert hashlib.sha256(blob).hexdigest()==PACKET_SHA
start=time.monotonic()
def boundary():
 p=pathlib.Path('/etc/apparmor.d/bartosz-ote-chromium-153_0_8010_12-enforced-v2')
 return {'profiles_sha256':hashlib.sha256(pathlib.Path('/sys/kernel/security/apparmor/profiles').read_bytes()).hexdigest(),
  'candidate_file_absent':not p.exists(),'runtime_absent':not pathlib.Path('/opt/bartosz-intelligence/browser-runtimes').exists(),
  'sysctl':{str(p):p.read_text().strip()for p in [pathlib.Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'),
   pathlib.Path('/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined')]}}
before=boundary();result={'schema':'ote-v2-oracle-offline:1','uid':os.geteuid(),'source_sha256':SOURCE_HASHES,
 'host_security_changes':0,'browser_executions':0,'profile_loads':0,'source_requests':0,
 'test_environment':{'machine':platform.machine(),'kernel':platform.release(),'python':platform.python_version()}}
with tempfile.TemporaryDirectory(prefix='ote-v2-offline-')as temporary:
 root=pathlib.Path(temporary);assert root.parent==pathlib.Path('/tmp');root.chmod(0o700)
 with tarfile.open(fileobj=io.BytesIO(blob),mode='r:gz')as tar:tar.extractall(root,filter='data')
 sys.path.insert(0,str(root));import enforced,policy
 env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'}
 p=subprocess.run(['/usr/bin/python3','-B',str(root/'v2-contracts.py')],cwd=root,env=env,capture_output=True,timeout=20)
 result['contracts']={'exit_code':p.returncode,'pass':p.returncode==0,'stderr':p.stderr.decode()[-8192:],
  'receipt':json.loads(p.stdout)if p.stdout else None}
 lock=enforced.load_lock(root/'v2-library-lock.json')
 result['current_system_library_validation']=enforced.validate_system(lock)
 result['profile_compilation']={}
 text=(root/'bartosz-ote-chromium-153_0_8010_12-enforced-v2.apparmor').read_bytes()
 for name,source,expected in [('candidate',text,True),('invalid_syntax',text.replace(b'  userns,',b'  userns INVALID,'),False)]:
  command=['/usr/sbin/apparmor_parser','--skip-kernel-load','--skip-cache','--stdout']
  p=subprocess.run(command,input=source,cwd=root,env=env,capture_output=True,timeout=15)
  result['profile_compilation'][name]={'command':command,'exit_code':p.returncode,'compiled_bytes':len(p.stdout),
   'compiled_sha256':hashlib.sha256(p.stdout).hexdigest(),'source_sha256':hashlib.sha256(source).hexdigest(),
   'stderr':p.stderr.decode()[:4096],'pass':p.returncode==0 if expected else p.returncode!=0,'kernel_load':False,'cache_writes':False}
 p=subprocess.run(['/usr/bin/python3','-B',str(root/'v2-active-tests.py'),'--output',str(root/'active-gate.json')],cwd=root,env=env,capture_output=True,timeout=10)
 result['active_gate']={'exit_code':p.returncode,'receipt':json.loads(p.stdout)}
result['temporary_files_removed']=not root.exists();result['before']=before;result['after']=boundary()
result['boundary_unchanged']=before==result['after'];result['elapsed_ms']=round((time.monotonic()-start)*1000)
result['max_child_rss_kib']=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
result['cpu_user_ms']=round(resource.getrusage(resource.RUSAGE_SELF).ru_utime*1000+resource.getrusage(resource.RUSAGE_CHILDREN).ru_utime*1000)
result['cpu_system_ms']=round(resource.getrusage(resource.RUSAGE_SELF).ru_stime*1000+resource.getrusage(resource.RUSAGE_CHILDREN).ru_stime*1000)
result['offline_checks_pass']=result['contracts']['pass']and all(x['pass']for x in result['profile_compilation'].values())and result['boundary_unchanged']
result['LIBRARY_BOUNDARY_READINESS']='CANDIDATE_COMPILED_ACTIVE_POLICY_PENDING'
result['SANDBOX_DEPLOYMENT_READINESS']='BLOCKED_SECURITY_MODEL_AND_ACTIVE_ACCEPTANCE';result['accepted']=False
print(json.dumps(result))
'''


def main():
    p=argparse.ArgumentParser();p.add_argument('--key',required=True,type=Path);p.add_argument('--output',required=True,type=Path);args=p.parse_args()
    names=['enforced.py','policy.py','install.py','runtime.json','assets.json','launcher-v2.py','v2-plan.py','v2-contracts.py',
        'enforced-runtime.json','v2-library-lock.json','v2-active-tests.py','positive.py','bartosz-ote-chromium-153_0_8010_12.apparmor',
        'bartosz-ote-chromium-153_0_8010_12-enforced-v2.apparmor']
    files={n:(HERE/n).read_bytes()for n in names};files['supervise.py']=(HERE.parent/'supervise.py').read_bytes();stream=io.BytesIO()
    with gzip.GzipFile(fileobj=stream,mode='wb',mtime=0,filename='')as gz:
        with tarfile.open(fileobj=gz,mode='w')as tar:
            for n,data in sorted(files.items()):
                e=tarfile.TarInfo(n);e.size=len(data);e.mode=0o600;tar.addfile(e,io.BytesIO(data))
    blob=stream.getvalue();source='PACKET='+repr(base64.b64encode(blob).decode())+'\nPACKET_SHA='+repr(sha256(blob).hexdigest())+'\nSOURCE_HASHES='+repr({n:sha256(b).hexdigest()for n,b in files.items()})+'\n'+REMOTE
    cmd=ssh(args.key);cmd[-1]='env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -I -'
    run=subprocess.run(cmd,input=source.encode(),capture_output=True,timeout=70)
    if run.returncode:raise SystemExit('V2_OFFLINE_FAILED:'+run.stderr.decode()[-4096:])
    result=json.loads(run.stdout);args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items()if k!='source_sha256'}));return 0 if result['offline_checks_pass']else 2


if __name__=='__main__':raise SystemExit(main())
