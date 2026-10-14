"""Read-only Oracle sandbox diagnostics; no sudo, profile load or host writes."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import subprocess

REMOTE = r'''
import errno,grp,hashlib,json,os,pathlib,pwd,re,resource,stat,subprocess,time
resource.setrlimit(resource.RLIMIT_CORE,(0,0))
def read(path,maximum=262144):
    try:
        p=pathlib.Path(path)
        with p.open('rb') as f:data=f.read(maximum+1)
        if len(data)>maximum:return {'error':'SIZE_LIMIT'}
        return data.decode('utf-8','replace').strip()
    except OSError as e:return {'error':errno.errorcode.get(e.errno,'READ_FAILED')}
def command(argv,seconds=8):
    try:
        p=subprocess.run(argv,capture_output=True,timeout=seconds,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'})
        return {'exit_code':p.returncode,'stdout':p.stdout[:4*1024*1024].decode('utf-8','replace'),
            'stdout_truncated':len(p.stdout)>4*1024*1024,'stderr':p.stderr[:4096].decode('utf-8','replace')}
    except FileNotFoundError:return {'error':'COMMAND_NOT_FOUND'}
    except subprocess.TimeoutExpired:return {'error':'COMMAND_TIMEOUT'}
def selected_status(path):
    text=read(path)
    if not isinstance(text,str):return text
    keys={'Name','Uid','Gid','CapInh','CapPrm','CapEff','CapBnd','CapAmb','NoNewPrivs','Seccomp','Seccomp_filters','NSpid'}
    return {line.split(':',1)[0]:line.split(':',1)[1].strip() for line in text.splitlines() if line.split(':',1)[0] in keys}
def metadata(path):
    p=pathlib.Path(path)
    try:
        s=p.lstat()
        return {'path':str(p),'uid':s.st_uid,'gid':s.st_gid,'mode':oct(stat.S_IMODE(s.st_mode)),
            'symlink':p.is_symlink(),'resolved':str(p.resolve()),'exists':True}
    except OSError as e:return {'path':str(p),'exists':False,'error':errno.errorcode.get(e.errno,'STAT_FAILED')}
result={'schema':'ote-sandbox-diagnosis:1','host_configuration_changed':False,'sudo_calls':0,'source_requests':0,
    'actor':{'uid':os.getuid(),'gid':os.getgid(),'user':pwd.getpwuid(os.getuid()).pw_name,
             'groups':[grp.getgrgid(g).gr_name for g in os.getgroups()]},
    'actor_status':selected_status('/proc/self/status'),'actor_apparmor':read('/proc/self/attr/current'),
    'pid1_status':selected_status('/proc/1/status'),'pid1_apparmor':read('/proc/1/attr/current'),
    'self_cgroup':read('/proc/self/cgroup'),'pid1_cgroup':read('/proc/1/cgroup'),
    'lsm':read('/sys/kernel/security/lsm'),'apparmor_enabled':read('/sys/module/apparmor/parameters/enabled')}
try:
    account=pwd.getpwnam('bartosz-executor');group=grp.getgrgid(account.pw_gid)
    result['execution_account']={'name':account.pw_name,'uid':account.pw_uid,'gid':account.pw_gid,
        'primary_group':group.gr_name,'supplementary_groups':[g.gr_name for g in grp.getgrall() if account.pw_name in g.gr_mem],
        'primary_group_users':[u.pw_name for u in pwd.getpwall() if u.pw_gid==account.pw_gid],
        'explicit_group_members':group.gr_mem}
except KeyError:result['execution_account']={'error':'ACCOUNT_NOT_FOUND'}
paths=['/proc/sys/kernel/unprivileged_userns_clone','/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
 '/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined','/proc/sys/user/max_user_namespaces']
result['sysctl']={p:read(p) for p in paths}
config=read('/boot/config-'+os.uname().release,1024*1024)
keys={'CONFIG_USER_NS','CONFIG_PID_NS','CONFIG_NET_NS','CONFIG_SECCOMP','CONFIG_SECCOMP_FILTER','CONFIG_SECURITY_APPARMOR'}
result['kernel_features']={line.split('=')[0]:line.split('=',1)[1] for line in config.splitlines() if line.split('=')[0] in keys} if isinstance(config,str) else config
result['loaded_profiles']=read('/sys/kernel/security/apparmor/profiles',1024*1024)
if isinstance(result['loaded_profiles'],str):
    result['loaded_profiles']=[s for s in result['loaded_profiles'].splitlines() if re.search('chrome|chromium|userns|unshare|bwrap',s,re.I)]
result['profiles']={}
for p in pathlib.Path('/etc/apparmor.d').iterdir():
    if p.is_file() and re.search('chrome|chromium|userns|unshare|bwrap',p.name,re.I):
        body=read(p)
        result['profiles'][p.name]={'metadata':metadata(p),'content':body}
result['parser_version']=command(['/usr/sbin/apparmor_parser','--version'])
result['parser_help']=command(['/usr/sbin/apparmor_parser','--help'])
result['aa_status']=command(['/usr/sbin/aa-status','--json'])
result['paths']=[metadata(p) for p in ['/', '/tmp','/opt','/opt/bartosz-intelligence',
 '/opt/bartosz-intelligence/browser-runtimes','/usr/bin/chromium','/snap/bin/chromium','/opt/google/chrome/chrome']]
result['remaining_ote_temp_paths']=[metadata(p) for p in pathlib.Path('/tmp').glob('bartosz-ote-*')]
result['mount_flags']=[line.split()[0:4] for line in read('/proc/mounts').splitlines() if line.split()[1] in {'/','/tmp','/opt'}]
logs={}
allowed={'apparmor','operation','class','info','error','profile','pid','comm','requested','denied','target','capname','capability','namespace','name'}
for name,argv in [('journal_kernel',['/usr/bin/journalctl','-k','--since','2026-10-13 00:00:00 UTC','-n','5000','--no-pager','-o','json']),
                  ('dmesg',['/usr/bin/dmesg','--color=never'])]:
    p=command(argv)
    events=[]
    for line in p.get('stdout','').splitlines():
        try:
            entry=json.loads(line) if name=='journal_kernel' else {'MESSAGE':line}
            message=entry.get('MESSAGE','')
            if not re.search('apparmor|seccomp|audit',message,re.I) or not re.search('userns|chrome|chromium|unshare',message,re.I):continue
            fields={k:v1 or v2 for k,v1,v2 in re.findall(r'(\w+)=(?:"([^"]*)"|(\S+))',message) if k in allowed}
            events.append({'timestamp_us':entry.get('__REALTIME_TIMESTAMP'),'fields':fields,'message_sha256':hashlib.sha256(message.encode()).hexdigest()})
        except (ValueError,TypeError):continue
    logs[name]={k:v for k,v in p.items() if k!='stdout'}
    logs[name]['events']=events[-120:]
result['logs']=logs
print(json.dumps(result))
'''


def ssh(key):
    return ['C:/Windows/System32/OpenSSH/ssh.exe', '-F', 'NUL', '-i', str(key.resolve()),
        '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
        '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', 'ubuntu@89.168.89.196',
        'env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/bin/python3 -B -']


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--key',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args()
    run=subprocess.run(ssh(args.key),input=REMOTE.encode(),capture_output=True,timeout=90)
    if run.returncode:
        raise SystemExit('READONLY_DIAGNOSTIC_FAILED_'+sha256(run.stderr).hexdigest())
    result=json.loads(run.stdout)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'schema':result['schema'],'actor':result['actor'],'execution_account':result['execution_account'],
        'sysctl':result['sysctl'],'actor_status':result['actor_status'],
        'profiles':list(result['profiles']),'logs':{k:{'exit_code':v.get('exit_code'),'events':len(v['events'])}for k,v in result['logs'].items()}}))


if __name__=='__main__':main()
