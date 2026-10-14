"""Narrow read-only browser availability audit; never invoke snap/snapd or apt install."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
from diagnose import ssh

REMOTE=r'''
import errno,hashlib,json,os,pathlib,platform,pwd,resource,stat,subprocess,time
start=time.monotonic()
def read(path,limit=1048576):
 try:
  with open(path,'rb')as f:data=f.read(limit+1)
  assert len(data)<=limit
  return data.decode('utf-8','replace').strip()
 except OSError as e:return {'error':errno.errorcode.get(e.errno,'READ_ERROR')}
def command(args):
 try:
  p=subprocess.run(args,capture_output=True,timeout=12,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'})
  assert len(p.stdout)<=2097152
  return {'argv':args,'exit_code':p.returncode,'stdout':p.stdout.decode('utf-8','replace'),'stderr':p.stderr[:4096].decode('utf-8','replace')}
 except FileNotFoundError:return {'argv':args,'error':'NOT_INSTALLED'}
 except subprocess.TimeoutExpired:return {'argv':args,'error':'TIMEOUT_NO_RETRY'}
def meta(path):
 try:
  p=pathlib.Path(path);s=p.lstat()
  return {'uid':s.st_uid,'gid':s.st_gid,'mode':oct(stat.S_IMODE(s.st_mode)),'bytes':s.st_size,
   'symlink':os.readlink(p)if p.is_symlink()else None,'exists':True}
 except FileNotFoundError:return {'exists':False}
def digest(path):
 h=hashlib.sha256()
 with open(path,'rb')as f:
  while block:=f.read(1048576):h.update(block)
 return h.hexdigest()
def boundary():
 return {'profiles_sha256':hashlib.sha256(pathlib.Path('/sys/kernel/security/apparmor/profiles').read_bytes()).hexdigest(),
  'sysctl':{p:read(p)for p in ['/proc/sys/kernel/apparmor_restrict_unprivileged_userns','/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined','/proc/sys/kernel/unprivileged_userns_clone']},
  'units':command(['/usr/bin/systemctl','show','snapd.service','snapd.socket','snapd.apparmor.service','apparmor.service','ssh.service','--property=Id,LoadState,ActiveState,SubState,MainPID,UnitFileState']),
  'snap_state_metadata':meta('/var/lib/snapd/state.json')}
before=boundary()
result={'schema':'ote-browser-architecture-audit:1','actor_uid':os.geteuid(),
 'environment':{'machine':platform.machine(),'kernel':platform.release(),'python':platform.python_version()},
 'package_inventory':command(['/usr/bin/dpkg-query','-W','-f=${Package}\t${Version}\t${Architecture}\t${db:Status-Abbrev}\n','snapd','chromium-browser','apparmor','systemd','squashfs-tools','bubblewrap']),
 'systemd_version':command(['/usr/bin/systemd-analyze','--version']),
 'filesystem_types':read('/proc/filesystems'),'cgroup_controllers':read('/sys/fs/cgroup/cgroup.controllers'),
 'paths':{p:meta(p)for p in ['/usr/bin/snap','/usr/lib/snapd/snap-confine','/snap/bin/chromium','/usr/bin/chromium','/usr/bin/chromium-browser',
 '/snap/chromium','/etc/apparmor.d','/var/lib/snapd/apparmor/profiles','/var/lib/snapd/seccomp/bpf',
 '/opt/bartosz-intelligence','/etc/bartosz-intelligence','/opt/bartosz-intelligence/browser-runtimes','/home/bartosz-browser',
 '/opt/bartosz-intelligence/runtime/node-24.21.0/bin/node']},
 'snap_mounts':[line for line in read('/proc/mounts').splitlines()if '/snap/'in line],
 'disk':{p:{'available_bytes':os.statvfs(p).f_bavail*os.statvfs(p).f_frsize}for p in ['/','/var/lib','/home']},
 'memory':{line.split(':')[0]:line.split(':')[1].strip()for line in read('/proc/meminfo').splitlines()if line.startswith(('MemTotal:','MemAvailable:','SwapTotal:'))},
 'profiles':{},'loaded_browser_profiles':[],
 'host_changes':0,'browser_executions':0,'snap_cli_calls':0,'service_starts':0,'source_requests':0}
result['active_snapd_helper']={'path':'/snap/snapd/current/usr/lib/snapd/snap-confine',
 'resolved':str(pathlib.Path('/snap/snapd/current/usr/lib/snapd/snap-confine').resolve()),
 'metadata':meta('/snap/snapd/current/usr/lib/snapd/snap-confine')}
result['helper_capabilities']=command(['/usr/sbin/getcap','-v','/usr/lib/snapd/snap-confine','/snap/snapd/current/usr/lib/snapd/snap-confine'])
result['helper_statoverride']=command(['/usr/bin/dpkg-statoverride','--list','/usr/lib/snapd/snap-confine'])
result['existing_node_sha256']=digest('/opt/bartosz-intelligence/runtime/node-24.21.0/bin/node')
profiles=read('/sys/kernel/security/apparmor/profiles')
result['loaded_browser_profiles']=[line for line in profiles.splitlines()if any(word in line.lower()for word in ['chromium','chrome','snap-confine','bwrap','userns'])]
for folder in ['/etc/apparmor.d','/var/lib/snapd/apparmor/profiles']:
 p=pathlib.Path(folder)
 if not p.exists():continue
 for f in sorted(p.iterdir()):
  if f.is_file()and any(x in f.name.lower()for x in ['chromium','chrome','snap-confine','bwrap','userns']):
   body=read(f)
   result['profiles'][str(f)]={'metadata':meta(f),'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'content':body}
state=pathlib.Path('/var/lib/snapd/state.json')
if state.exists():
 value=json.loads(read(state,16777216));snaps=value.get('data',{}).get('snaps',{})
 result['installed_snaps']={name:{k:v.get(k)for k in ['active','current','tracking-channel','type']}for name,v in snaps.items()}
else:result['installed_snaps']={}
try:
 a=pwd.getpwnam('bartosz-browser');result['browser_account']={'exists':True,'uid':a.pw_uid,'gid':a.pw_gid,'home':a.pw_dir,'shell':a.pw_shell}
except KeyError:result['browser_account']={'exists':False}
result['before']=before;result['after']=boundary();result['boundary_unchanged']=before==result['after']
result['elapsed_ms']=round((time.monotonic()-start)*1000)
result['observer_maxrss_kib']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
print(json.dumps(result))
'''


def main():
    p=argparse.ArgumentParser();p.add_argument('--key',required=True,type=Path);p.add_argument('--output',required=True,type=Path);args=p.parse_args()
    if args.output.exists():raise SystemExit('NEW_AUDIT_OUTPUT_REQUIRED')
    command=ssh(args.key);command[-1]='env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C /usr/bin/python3 -I -'
    run=subprocess.run(command,input=REMOTE.encode(),capture_output=True,timeout=60)
    if run.returncode:raise SystemExit('READ_ONLY_AUDIT_FAILED:'+run.stderr.decode()[-2048:])
    value=json.loads(run.stdout);value['observer_source_sha256']=sha256(REMOTE.encode()).hexdigest()
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(value,indent=2)+'\n')
    print(json.dumps({k:v for k,v in value.items()if k not in {'profiles','before','after'}}))
    return 0 if value['boundary_unchanged']else 2


if __name__=='__main__':raise SystemExit(main())
