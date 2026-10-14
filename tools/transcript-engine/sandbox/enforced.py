"""V2 exact file-backed executable mapping candidate. No installation API."""
from hashlib import sha256
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import policy

PROFILE='bartosz-ote-chromium-153_0_8010_12-enforced-v2'
ROOT=policy.BASE+'/chromium-headless-shell-153.0.8010.12'
SYSTEM_ROOT='/usr/lib/aarch64-linux-gnu/'
HASH=re.compile('[a-f0-9]{64}')


def digest(path):
    h=sha256()
    with Path(path).open('rb')as f:
        while chunk:=f.read(1024*1024):h.update(chunk)
    return h.hexdigest()


def elf_info(data):
    policy.require(data[:6]==b'\x7fELF\x02\x01'and len(data)>=64,'ARM64_ELF_REQUIRED')
    policy.require(struct.unpack_from('<H',data,18)[0]==183,'ARM64_ELF_REQUIRED')
    offset=struct.unpack_from('<Q',data,32)[0];size,count=struct.unpack_from('<HH',data,54)
    policy.require(count<256 and size>=56 and offset+size*count<=len(data),'ELF_PROGRAM_HEADERS')
    headers=[struct.unpack_from('<IIQQQQQQ',data,offset+i*size)for i in range(count)]
    loads=[h for h in headers if h[0]==1]
    def at(address):
        for h in loads:
            if h[3]<=address<h[3]+h[5]:return h[2]+address-h[3]
        raise policy.Rejected('ELF_VIRTUAL_ADDRESS')
    needed=[];strings=None;soname=None;search=[];interpreter=None
    for h in headers:
        if h[0]==3:interpreter=data[h[2]:h[2]+h[5]].rstrip(b'\0').decode()
        if h[0]!=2:continue
        policy.require(h[2]+h[5]<=len(data)and h[5]<1024*1024,'ELF_DYNAMIC_LIMIT')
        for pos in range(h[2],h[2]+h[5],16):
            tag,value=struct.unpack_from('<qQ',data,pos)
            if tag==0:break
            if tag==1:needed.append(value)
            if tag==5:strings=at(value)
            if tag==14:soname=value
            if tag in {15,29}:search.append(value)
    def string(index):
        policy.require(strings is not None,'ELF_STRING_TABLE')
        start=strings+index;end=data.find(b'\0',start,start+4096)
        policy.require(end>=start,'ELF_STRING_LIMIT');return data[start:end].decode()
    names=[string(n)for n in needed]
    policy.require(all(re.fullmatch('[A-Za-z0-9._+-]+',n)for n in names),'ELF_NEEDED_PATH')
    return {'needed':names,'interpreter':interpreter,'soname':string(soname)if soname is not None else None,'rpath_runpath':[string(n)for n in search]}


def old_config(c):
    old={k:v for k,v in c.items()if k not in {'library_lock_sha256','policy_generation'}}
    old.update(schema='ote-managed-browser:1',launcher=ROOT+'/launcher.py',apparmor_profile_name=PROFILE.removesuffix('-enforced-v2'),
        apparmor_profile_path='/etc/apparmor.d/'+PROFILE.removesuffix('-enforced-v2'))
    return old


def validate_config(c):
    policy.require(c.get('schema')=='ote-managed-browser:2'and c.get('policy_generation')==2,'V2_CONFIG_SCHEMA')
    policy.require(c.get('version')=='153.0.8010.12'and c.get('runtime_root')==ROOT,'V2_PINNED_VERSION')
    policy.require(c.get('launcher')==ROOT+'/launcher-v2.py'and c.get('apparmor_profile_name')==PROFILE
        and c.get('apparmor_profile_path')=='/etc/apparmor.d/'+PROFILE,'V2_EXACT_TARGET')
    policy.require(HASH.fullmatch(c.get('library_lock_sha256','')),'V2_LOCK_HASH')
    policy.validate_config(old_config(c));return c


def exact_path(path,kind):
    policy.require(isinstance(path,str)and str(PurePosixPath(path))==path and path.startswith('/')
        and re.fullmatch('/[A-Za-z0-9/._+-]+',path)and '..'not in PurePosixPath(path).parts,'V2_LITERAL_PATH')
    if kind=='runtime':
        policy.require(path==ROOT+'/chrome-headless-shell'or re.fullmatch(re.escape(ROOT)+r'/lib[A-Za-z0-9._+-]+\.so(?:\.[0-9]+)*',path),'V2_RUNTIME_MAPPING_PATH')
    elif kind=='system':
        policy.require(path.startswith(SYSTEM_ROOT)and ('/gconv/'in path or PurePosixPath(path).parent==PurePosixPath(SYSTEM_ROOT)),'V2_SYSTEM_MAPPING_PATH')
        policy.require('.so'in PurePosixPath(path).name,'V2_SYSTEM_LIBRARY_NAME')
    else:raise policy.Rejected('V2_MAPPING_KIND')


def metadata(path):
    p=Path(path);s=p.lstat();x=os.listxattr(p,follow_symlinks=False)
    return {'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode),'nlink':s.st_nlink,
        'type':'symlink'if stat.S_ISLNK(s.st_mode)else'directory'if stat.S_ISDIR(s.st_mode)else'file'if stat.S_ISREG(s.st_mode)else'other',
        'acl':any(k in {'system.posix_acl_access','system.posix_acl_default'}for k in x),
        'file_capabilities':'security.capability'in x,'target':os.readlink(p)if stat.S_ISLNK(s.st_mode)else None}


def check_metadata(m):
    policy.require(m['uid']==0,'V2_ROOT_OWNER')
    policy.require(not m['acl'],'V2_EXTENDED_ACL_FORBIDDEN')
    policy.require(not m['file_capabilities'],'V2_FILE_CAPABILITIES_FORBIDDEN')
    policy.require(m['type']in {'file','directory','symlink'},'V2_FILE_TYPE')
    if m['type']!='symlink':
        policy.require(not m['mode']&0o022,'V2_NONROOT_WRITE')
        policy.require(not m['mode']&0o7000,'V2_SPECIAL_MODE')
    if m['type']=='file':policy.require(m['nlink']==1,'V2_HARDLINK_FORBIDDEN')


def chain(path):
    """Inspect lexical aliases before resolution and every resolved ancestor."""
    requested=Path(path);policy.require(requested.is_absolute(),'V2_ABSOLUTE_PATH')
    records={};pending=[requested];seen=set()
    while pending:
        p=pending.pop()
        policy.require(len(seen)<128,'V2_SYMLINK_CHAIN_LIMIT')
        for entry in [*reversed(p.parents),p]:
            if str(entry)in seen:continue
            seen.add(str(entry));m=metadata(entry);check_metadata(m);records[str(entry)]=m
            if m['type']=='symlink':
                target=Path(m['target'])
                pending.append(target if target.is_absolute()else entry.parent/target)
    resolved=requested.resolve(strict=True)
    for entry in [*reversed(resolved.parents),resolved]:
        m=metadata(entry);check_metadata(m);records[str(entry)]=m
    return {'requested':str(requested),'resolved':str(resolved),'components':records}


def validate_lock(lock):
    policy.require(lock.get('schema')=='ote-executable-mappings:2','V2_LOCK_SCHEMA')
    rows=lock.get('files');policy.require(isinstance(rows,dict)and 1<=len(rows)<=256,'V2_LOCK_COUNT')
    for path,row in rows.items():
        exact_path(path,row.get('kind'))
        policy.require(HASH.fullmatch(row.get('sha256',''))and type(row.get('bytes'))is int and 0<row['bytes']<400*1024*1024,'V2_MAPPING_HASH_SIZE')
        check_metadata(row)
        policy.require(row['type']=='file'and row['target']is None,'V2_CANONICAL_MAPPING_REQUIRED')
    policy.require(ROOT+'/chrome-headless-shell'in rows,'V2_EXECUTABLE_MAPPING_MISSING')
    policy.require(lock.get('dynamic_observation')=='NOT_RUN_ACTIVE_POLICY_REQUIRED','V2_LATE_LOAD_CLAIM')
    return rows


def load_lock(path):return validate_and_return_lock(policy.load(Path(path),4*1024*1024))
def validate_and_return_lock(lock):validate_lock(lock);return lock


def profile_text(c,lock):
    validate_config(c);rows=validate_lock(lock);name=c['apparmor_profile_name']
    lines=['# Candidate v2: exact file-backed mappings; active-policy acceptance pending.',
        '# No abstraction imports: mapping grants are completely enumerated below.',
        'abi <abi/4.0>,',f'profile {name} "{c["executable"]}" flags=(enforce,mediate_deleted) {{',
        '  userns,','  capability sys_admin,','  capability sys_chroot,',
        '  deny mount,','  deny remount,','  deny umount,','  deny pivot_root,',
        '  deny change_profile,',f'  signal (send, receive) peer={name},','  signal (receive) peer=unconfined,',
        f'  ptrace (read, readby) peer={name},','  ptrace (readby) peer=unconfined,',
        '  network inet stream,','  network inet6 stream,',
        '  unix (create) type=stream,','  unix (create) type=seqpacket,','  unix (create) type=dgram,',
        '  unix (bind, listen, shutdown, getopt, setopt) addr=none,',
        f'  unix (connect, accept, send, receive) peer=(label={name}),',
        '  /proc/ r,','  /proc/{cpuinfo,meminfo,stat,version,uptime,loadavg} r,',
        '  /proc/sys/{kernel/osrelease,kernel/ostype,kernel/random/uuid,vm/overcommit_memory} r,',
        '  owner /proc/{self,[0-9]*}/ r,',
        '  owner /proc/{self,[0-9]*}/{status,stat,statm,maps,smaps,cmdline,auxv,limits,oom_score,comm} r,',
        '  owner /proc/{self,[0-9]*}/{uid_map,gid_map,setgroups,oom_score_adj} rw,',
        '  owner /proc/{self,[0-9]*}/{fd,fdinfo,task,ns}/ r,',
        '  owner /proc/{self,[0-9]*}/fd/[0-9]* rw,',
        '  owner /proc/{self,[0-9]*}/fdinfo/[0-9]* r,',
        '  owner /proc/{self,[0-9]*}/task/[0-9]*/{status,stat,comm} r,',
        '  owner /proc/{self,[0-9]*}/ns/{user,pid,net,mnt} r,',
        '  /dev/{null,zero,full,random,urandom} rw,','  /dev/shm/ r,',
        '  owner /dev/shm/.org.chromium.* rwk,','  /tmp/ r,',
        '  owner /tmp/bartosz-ote-profile-*/ rw,','  owner /tmp/bartosz-ote-profile-*/** rwk,',
        '  owner /tmp/.org.chromium.* rwk,',
        '  /etc/{ld.so.cache,nsswitch.conf,host.conf,hosts,resolv.conf,localtime,machine-id} r,',
        '  /usr/share/{zoneinfo,fonts,fontconfig}/** r,','  /etc/fonts/** r,',
        '  /sys/devices/system/cpu/** r,','  /sys/devices/system/node/** r,',
        f'  "{ROOT}/" r,',f'  "{ROOT}/**" r,']
    for path in sorted(rows):lines.append(f'  "{path}" '+('mrix'if path==c['executable']else'mr')+',')
    return '\n'.join(lines+['}',''])


def validate_profile(c,lock,text):
    policy.require(text.replace('\r\n','\n')==profile_text(c,lock),'V2_PROFILE_EXACT_CONTRACT')
    return {'exact_m_paths':len(lock['files']),'exact_exec_paths':1,'mode':'enforce','includes':0}


def validate_system(lock):
    rows=validate_lock(lock);checked=[]
    for path,row in rows.items():
        if row['kind']!='system':continue
        actual=chain(path);policy.require(actual['resolved']==path,'V2_MAPPING_ALIAS_CHANGED')
        policy.require(metadata(path)=={k:row[k]for k in metadata(path)},'V2_LIBRARY_METADATA_CHANGED')
        policy.require(Path(path).stat().st_size==row['bytes']and digest(path)==row['sha256'],'V2_LIBRARY_BYTES_CHANGED')
        checked.append(path)
    for alias,row in lock.get('aliases',{}).items():
        actual=chain(alias);policy.require(actual==row,'V2_SYMLINK_OR_PARENT_CHANGED')
    return {'system_mapping_paths_verified':len(checked)}


def validate_runtime(c,lock,check_profile=True):
    validate_config(c);validate_lock(lock);policy.account_matches(c)
    base=Path(c['runtime_root']);boundary=chain(base)
    policy.require(boundary['resolved']==str(base),'V2_RUNTIME_ALIAS')
    policy.check_meta(policy.metadata(base),directory=True,gid=c['gid'],mode=0o750)
    validate_system(lock)
    assets=policy.validate_assets(old_config(c),policy.load(base/'assets.json'))
    controls={'launcher-v2.py','enforced.py','policy.py','enforced-runtime.json','v2-library-lock.json','assets.json'}
    policy.require(all((base/name).is_file()for name in controls),'V2_CONTROL_FILE_MISSING')
    known=set(assets)|controls|{'install-receipt-v2.json'}
    for p in base.rglob('*'):
        m=metadata(p);check_metadata(m)
        policy.require(m['type']!='symlink','V2_RUNTIME_SYMLINK')
        if m['type']=='directory':policy.require(m['mode']==0o750 and m['gid']==c['gid'],'V2_RUNTIME_DIR_MODE')
        else:
            key=p.relative_to(base).as_posix();policy.require(key in known,'V2_UNMANAGED_RUNTIME_FILE')
            mode=0o750 if key in {'chrome-headless-shell','launcher-v2.py'}else 0o640
            policy.require(m['mode']==mode and m['gid']==c['gid'],'V2_RUNTIME_FILE_MODE')
    for name,row in assets.items():
        p=base/name;policy.require(p.stat().st_size==row['bytes']and digest(p)==row['sha256'],'V2_RUNTIME_ASSET_CHANGED')
    policy.require(policy.load(base/'enforced-runtime.json')==c,'V2_INSTALLED_CONFIG_CHANGED')
    policy.require(digest(base/'v2-library-lock.json')==c['library_lock_sha256'],'V2_INSTALLED_LOCK_CHANGED')
    policy.require(policy.load(base/'v2-library-lock.json')==lock,'V2_INSTALLED_LOCK_CONTENT_CHANGED')
    for path,row in lock['files'].items():
        if row['kind']=='runtime':
            actual=chain(path);policy.require(actual['resolved']==path,'V2_RUNTIME_MAPPING_ALIAS')
            m=metadata(path);policy.require(m=={k:row[k]for k in m},'V2_RUNTIME_MAPPING_METADATA_CHANGED')
            policy.require(Path(path).stat().st_size==row['bytes']and digest(path)==row['sha256'],'V2_RUNTIME_MAPPING_CHANGED')
    if check_profile:
        p=Path(c['apparmor_profile_path']);chain(p);validate_profile(c,lock,p.read_text())
        m=metadata(p);policy.require(m['type']=='file'and m['gid']==0 and m['mode']==0o644,'V2_PROFILE_FILE_MODE')
    return {'runtime_assets_verified':len(assets),'mapping_paths_verified':len(lock['files']),
        'late_dynamic_loads_observed':False,'active_library_boundary_proven':False}


def rollback_targets(c):
    """Revocation must not depend on healthy assets or an accessible runtime."""
    validate_config(c);root=Path(c['runtime_root']);profile=Path(c['apparmor_profile_path'])
    boundary=chain(root);policy.require(boundary['resolved']==str(root),'V2_RUNTIME_ALIAS')
    m=metadata(root)
    policy.require(m['type']=='directory'and m['gid']==c['gid']and m['mode']in {0o700,0o750},'V2_ROLLBACK_RUNTIME_BOUNDARY')
    parent=chain(profile.parent);policy.require(parent['resolved']==str(profile.parent),'V2_PROFILE_PARENT_ALIAS')
    if profile.exists()or profile.is_symlink():
        found=chain(profile);policy.require(found['resolved']==str(profile),'V2_PROFILE_ALIAS')
        m=metadata(profile)
        policy.require(m['type']=='file'and m['gid']==0 and m['mode']==0o644,'V2_PROFILE_FILE_MODE')
        return {'profile_file_present':True,'original_profile_sha256':digest(profile),'original_profile_metadata':m}
    return {'profile_file_present':False,'original_profile_sha256':None}
