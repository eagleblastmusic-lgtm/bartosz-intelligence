"""Loader-only negative preflight. No policy load, browser main or source access.

Uses a pinned ELF and a copy of a system library in a disposable directory.
The linker is invoked as UID 997 with LD_TRACE_LOADED_OBJECTS, which exits before
Chromium main. Demonstrates whether the nonroot caller can select its libraries.
"""
import argparse
import base64
from hashlib import sha256
import json
from pathlib import Path
import subprocess
from diagnose import ssh

HERE=Path(__file__).resolve().parent
REMOTE=r'''
from hashlib import sha256
import io,json,os,pathlib,resource,shutil,stat,subprocess,tempfile,time,urllib.request,zipfile
assert os.geteuid()==0
started=time.monotonic();usage=resource.getrusage(resource.RUSAGE_CHILDREN)
profiles_before=pathlib.Path('/sys/kernel/security/apparmor/profiles').read_bytes()
sysctl_paths=['/proc/sys/kernel/unprivileged_userns_clone','/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
 '/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined','/proc/sys/user/max_user_namespaces']
settings_before={p:pathlib.Path(p).read_bytes()for p in sysctl_paths}
result={'schema':'ote-library-boundary-probe:1','browser_main_executions':0,'browser_root_executions':0,
 'source_requests':0,'profile_loads':0,'test_uid':997,'test_gid':988,'memory_limit_bytes':768*1024*1024}
class Redirects(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  from urllib.parse import urlsplit
  u=urlsplit(newurl)
  assert u.scheme=='https' and u.hostname in {'cdn.playwright.dev','storage.googleapis.com','playwright.download.prss.microsoft.com','cdn.playwright.download.prss.microsoft.com'},'DOWNLOAD_REDIRECT_NOT_ALLOWED'
  return super().redirect_request(req,fp,code,msg,headers,newurl)
with tempfile.TemporaryDirectory(prefix='ote-library-boundary-')as temporary:
 root=pathlib.Path(temporary);assert root.parent==pathlib.Path('/tmp')
 os.chown(root,0,988);root.chmod(0o750)
 archive=root/'browser.zip';size=0;h=sha256()
 opener=urllib.request.build_opener(Redirects())
 with opener.open(CONFIG['archive_url'],timeout=20)as response,archive.open('xb')as f:
  result['download_final_url']=response.url
  while True:
   data=response.read(1024*1024)
   if not data:break
   size+=len(data);assert size<=256*1024*1024 and time.monotonic()-started<90
   h.update(data);f.write(data)
 assert h.hexdigest()==CONFIG['archive_sha256']
 result['archive_sha256']=h.hexdigest();result['archive_bytes']=size
 runtime=root/'runtime';runtime.mkdir(mode=0o750);os.chown(runtime,0,988)
 with zipfile.ZipFile(archive)as z:
  assert len(z.infolist())<=512 and sum(e.file_size for e in z.infolist())<600*1024*1024
  for name,row in ASSETS['files'].items():
   p=runtime/name;assert p.is_relative_to(runtime)and '..'not in p.parts
   p.parent.mkdir(parents=True,exist_ok=True)
   for parent in [p.parent]+list(p.parent.parents):
    if parent==root:break
    assert parent.is_relative_to(runtime);os.chown(parent,0,988);parent.chmod(0o750)
   data=z.read('chrome-headless-shell-linux-arm64/'+name)
   assert len(data)==row['bytes']and sha256(data).hexdigest()==row['sha256']
   p.write_bytes(data);os.chown(p,0,988);p.chmod(row['mode'])
 binary=runtime/'chrome-headless-shell'
 before=sha256(binary.read_bytes()).hexdigest();assert before==CONFIG['executable_sha256']
 payload=root/'caller-libraries';payload.mkdir(mode=0o700);os.chown(payload,997,988)
 system_library=pathlib.Path('/usr/lib/aarch64-linux-gnu/libz.so.1').resolve()
 assert system_library.stat().st_uid==0 and not system_library.stat().st_mode&0o022
 library=payload/'libz.so.1';shutil.copyfile(system_library,library);os.chown(library,997,988);library.chmod(0o600)
 result['pinned_binary']={'sha256':before,'uid':binary.stat().st_uid,'gid':binary.stat().st_gid,'mode':oct(stat.S_IMODE(binary.stat().st_mode))}
 result['caller_library']={'sha256':sha256(library.read_bytes()).hexdigest(),'uid':library.stat().st_uid,'mode':oct(stat.S_IMODE(library.stat().st_mode)),'source':str(system_library)}
 result['loader_cases']={}
 for name,extra in [('baseline',{}),('LD_PRELOAD',{'LD_PRELOAD':str(library)}),('LD_LIBRARY_PATH',{'LD_LIBRARY_PATH':str(payload)})]:
  env={'PATH':'/usr/bin:/bin','LANG':'C','LD_TRACE_LOADED_OBJECTS':'1',**extra}
  p=subprocess.run([str(binary),'--version'],user=997,group=988,extra_groups=[],env=env,capture_output=True,timeout=8)
  selected=str(library).encode()in p.stdout
  result['loader_cases'][name]={'exit_code':p.returncode,'caller_library_selected':selected,
   'selected_line':next((line.decode('utf-8','replace')for line in p.stdout.splitlines()if str(library).encode()in line),None),
   'stdout_sha256':sha256(p.stdout).hexdigest(),'stderr_sha256':sha256(p.stderr).hexdigest(),
   'missing_libraries':[line.decode('utf-8','replace').strip()for line in p.stdout.splitlines()if b'not found'in line]}
 assert sha256(binary.read_bytes()).hexdigest()==before
 result['binary_unchanged']=True
 result['temporary_path']=str(root)
result['temporary_directory_removed']=not root.exists()
result['loaded_profiles_unchanged']=pathlib.Path('/sys/kernel/security/apparmor/profiles').read_bytes()==profiles_before
result['sysctl_unchanged']=settings_before=={p:pathlib.Path(p).read_bytes()for p in sysctl_paths}
result['elapsed_ms']=round((time.monotonic()-started)*1000)
u=resource.getrusage(resource.RUSAGE_CHILDREN)
result['loader_children_cpu_ms']=round((u.ru_utime+u.ru_stime-usage.ru_utime-usage.ru_stime)*1000,3)
result['observer_peak_rss_kib']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
result['counterexample_confirmed']=all(result['loader_cases'][k]['exit_code']==0 and result['loader_cases'][k]['caller_library_selected']for k in ['LD_PRELOAD','LD_LIBRARY_PATH'])and not result['loader_cases']['baseline']['caller_library_selected']
result['profile_for_temporary_copy']='unconfined; target profile never loaded'
result['target_profile_library_mapping_restrictions']='NONE_IN_PREPARED_UNCONFINED_PROFILE'
result['accepted']=False
print(json.dumps(result))
'''


def main():
    p=argparse.ArgumentParser();p.add_argument('--key',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    args=p.parse_args()
    command=ssh(args.key)
    command[-1]='env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -I -'
    probe='CONFIG='+repr(json.loads((HERE/'runtime.json').read_text()))+'\nASSETS='+repr(json.loads((HERE/'assets.json').read_text()))+'\n'+REMOTE
    supervisor=(HERE.parent/'supervise.py').read_bytes()
    # The actual aggregate-RSS supervisor enforces the unchanged 768 MiB limit.
    source='PROBE='+repr(probe)+'\nSUPERVISOR='+repr(base64.b64encode(supervisor).decode())+'\n'+r'''
import base64,json,pathlib,subprocess,tempfile
with tempfile.TemporaryDirectory(prefix='ote-loader-supervised-')as temporary:
 root=pathlib.Path(temporary);assert root.parent==pathlib.Path('/tmp')
 (root/'probe.py').write_text(PROBE,encoding='utf-8')
 (root/'supervise.py').write_bytes(base64.b64decode(SUPERVISOR))
 p=subprocess.run(['/usr/bin/python3','-B',str(root/'supervise.py'),'--output',str(root/'resources.json'),
  '--memory-mib','768','--timeout','100','--','/usr/bin/python3','-I',str(root/'probe.py')],
  capture_output=True,timeout=112,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'})
 receipt=json.loads((root/'resources.json').read_text())
 assert p.returncode==0 and receipt['category']=='NONE'and receipt['exit_code']==0 and receipt['descendants_remaining']==0
 result=receipt.pop('child_result');assert result is not None
 result['supervisor']=receipt
result['supervisor_directory_removed']=not root.exists()
print(json.dumps(result))
'''
    run=subprocess.run(command,input=source.encode(),capture_output=True,timeout=125)
    if run.returncode:raise SystemExit('LIBRARY_PROBE_FAILED:'+run.stderr.decode('utf-8','replace')[-2048:])
    result=json.loads(run.stdout);args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result))
    return 0 if result['counterexample_confirmed']else 2


if __name__=='__main__':raise SystemExit(main())
