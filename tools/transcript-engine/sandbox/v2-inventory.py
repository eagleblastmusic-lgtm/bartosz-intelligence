"""Read-only Oracle library closure/ownership inventory; never runs the ELF."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import zipfile
from diagnose import ssh
import enforced
import policy

HERE=Path(__file__).resolve().parent
REMOTE=r'''
import json,os,pathlib,re,subprocess,time
started=time.monotonic()
profiles_before=pathlib.Path('/sys/kernel/security/apparmor/profiles').read_bytes()
settings={p:pathlib.Path(p).read_text().strip()for p in ['/proc/sys/kernel/unprivileged_userns_clone',
 '/proc/sys/kernel/apparmor_restrict_unprivileged_userns','/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined']}
p=subprocess.run(['/sbin/ldconfig','-p'],capture_output=True,timeout=10,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'})
assert p.returncode==0
paths={}
for line in p.stdout.decode().splitlines():
 m=re.search(r'^\s*(\S+)\s+\(([^)]+)\)\s+=>\s+(\S+)\s*$',line)
 if m and 'AArch64'in m[2]:paths.setdefault(m[1],m[3])
files={};aliases={};missing=[];queue=list(NEEDS);needed_by={n:['runtime ELF']for n in NEEDS}
optional=['libnss_files.so.2','libnss_dns.so.2','libresolv.so.2','libnss_compat.so.2','libnss_systemd.so.2']
late=[]
for n in optional:
 if n in paths:queue.append(n);late.append(n);needed_by.setdefault(n,[]).append('declared late NSS candidate')
while queue:
 name=queue.pop(0)
 if name in PROVIDED:continue
 source=paths.get(name)
 if not source:missing.append(name);continue
 trust=chain(source);resolved=trust['resolved']
 aliases[source]=trust
 if resolved in files:continue
 exact_path(resolved,'system')
 data=pathlib.Path(resolved).read_bytes();assert len(data)<128*1024*1024
 info=elf_info(data);meta=metadata(resolved);check_metadata(meta)
 files[resolved]={**meta,'kind':'system','bytes':len(data),'sha256':sha256(data).hexdigest(),'elf':info}
 for child in info['needed']:
  needed_by.setdefault(child,[]).append(resolved);queue.append(child)
 assert len(files)<256
loader=chain('/lib/ld-linux-aarch64.so.1');aliases[loader['requested']]=loader
resolved=loader['resolved']
if resolved not in files:
 data=pathlib.Path(resolved).read_bytes();files[resolved]={**metadata(resolved),'kind':'system','bytes':len(data),'sha256':sha256(data).hexdigest(),'elf':elf_info(data)}
result={'schema':'ote-v2-library-inventory:1','files':files,'aliases':aliases,'missing_needed':sorted(set(missing)),
 'declared_late_candidates':late,'needed_by':needed_by,'dynamic_observation':'NOT_RUN_ACTIVE_POLICY_REQUIRED',
 'host_settings':settings,'no_profile_loads':True,'no_elf_execution':True,
 'profiles_unchanged':profiles_before==pathlib.Path('/sys/kernel/security/apparmor/profiles').read_bytes(),
 'elapsed_ms':round((time.monotonic()-started)*1000)}
print(json.dumps(result))
'''


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--key',required=True,type=Path)
    parser.add_argument('--archive',required=True,type=Path);parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args();old=policy.load(HERE/'runtime.json')
    policy.require(enforced.digest(args.archive)==old['archive_sha256'],'ARCHIVE_HASH_MISMATCH')
    runtime={};needs=set();provided=set()
    with zipfile.ZipFile(args.archive)as z:
        for entry in z.infolist():
            name=entry.filename.removeprefix('chrome-headless-shell-linux-arm64/')
            if name!='chrome-headless-shell'and not name.startswith('lib'):continue
            data=z.read(entry)
            if data[:4]!=b'\x7fELF':continue
            info=enforced.elf_info(data);needs.update(info['needed'])
            if info['soname']:provided.add(info['soname'])
            runtime[enforced.ROOT+'/'+name]={'kind':'runtime','sha256':sha256(data).hexdigest(),'bytes':len(data),
                'uid':0,'gid':988,'mode':0o750 if name=='chrome-headless-shell'else 0o640,'nlink':1,
                'type':'file','acl':False,'file_capabilities':False,'target':None,'elf':info,'source':'pinned archive; not installed'}
    script=(HERE/'enforced.py').read_text().replace('import policy','')
    dependency=(HERE/'policy.py').read_text().replace('from __future__ import annotations','')
    source='NEEDS='+repr(sorted(needs))+'\nPROVIDED='+repr(sorted(provided))+'\n'+dependency+"\nimport types\npolicy=types.SimpleNamespace(require=require,BASE=BASE,Rejected=Rejected)\n"+script+'\n'+REMOTE
    command=ssh(args.key);command[-1]='env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -I -'
    run=subprocess.run(command,input=source.encode(),capture_output=True,timeout=60)
    if run.returncode:raise SystemExit('V2_INVENTORY_FAILED:'+run.stderr.decode()[-2048:])
    inventory=json.loads(run.stdout)
    policy.require(not inventory['missing_needed'],'V2_NEEDED_LIBRARY_MISSING')
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(inventory,indent=2)+'\n')
    lock={'schema':'ote-executable-mappings:2','files':{**runtime,**inventory['files']},'aliases':inventory['aliases'],
        'dynamic_observation':'NOT_RUN_ACTIVE_POLICY_REQUIRED','declared_late_candidates':inventory['declared_late_candidates'],
        'host_settings':inventory['host_settings'],'archive_sha256':old['archive_sha256']}
    enforced.validate_lock(lock)
    (HERE/'v2-library-lock.json').write_text(json.dumps(lock,indent=2)+'\n')
    c={**old,'schema':'ote-managed-browser:2','policy_generation':2,'launcher':enforced.ROOT+'/launcher-v2.py',
        'apparmor_profile_name':enforced.PROFILE,'apparmor_profile_path':'/etc/apparmor.d/'+enforced.PROFILE,
        'library_lock_sha256':enforced.digest(HERE/'v2-library-lock.json')}
    enforced.validate_config(c);(HERE/'enforced-runtime.json').write_text(json.dumps(c,indent=2)+'\n')
    (HERE/(enforced.PROFILE+'.apparmor')).write_text(enforced.profile_text(c,lock),newline='\n')
    print(json.dumps({'mapping_files':len(lock['files']),'system_files':len(inventory['files']),
        'runtime_mapped_files':len(runtime),'aliases':len(lock['aliases']),'profiles_unchanged':inventory['profiles_unchanged'],
        'late_loads_observed':False,'active_policy_tested':False}))


if __name__=='__main__':main()
