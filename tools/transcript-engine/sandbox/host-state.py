"""Root read-only snapshot used before/after this one authorized deployment."""
from hashlib import sha256
import json
import os
from pathlib import Path
import stat
import subprocess
import sys


def command(args):
    p=subprocess.run(args,capture_output=True,timeout=15,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'})
    return p


def meta(p):
    try:
        s=p.lstat()
        return {'uid':s.st_uid,'gid':s.st_gid,'mode':oct(stat.S_IMODE(s.st_mode)),
            'symlink':p.is_symlink(),'directory':p.is_dir(),'target':os.readlink(p)if p.is_symlink()else None}
    except FileNotFoundError:return {'absent':True}


def hashes(directory):
    result={}
    for p in sorted(Path(directory).rglob('*')):
        if p.is_symlink():result[str(p)]={'link':os.readlink(p)}
        elif p.is_file():
            if p.stat().st_size>16*1024*1024:raise RuntimeError('SNAPSHOT_FILE_LIMIT')
            result[str(p)]={'sha256':sha256(p.read_bytes()).hexdigest(),**meta(p)}
    return result


def sudo_denied(result):
    # sudo -l -U can return zero even when its diagnostic denies this account.
    text=result.stdout+result.stderr
    return result.returncode in {0,1} and b'is not allowed to run sudo' in text and b'may run the following commands' not in text


def snapshot(c):
    import pwd,grp
    if os.geteuid()!=0 or not sys.flags.isolated:raise RuntimeError('ROOT_READONLY_OBSERVER_REQUIRED')
    user=pwd.getpwnam(c['account'])
    sudo=command(['/usr/bin/sudo','-n','-l','-U',c['account']])
    profiles=Path('/sys/kernel/security/apparmor/profiles').read_text().splitlines()
    units={}
    for name in ['ssh.service','apparmor.service','bartosz-executor.service']:
        p=command(['/usr/bin/systemctl','show',name,'--no-pager','--property=LoadState,ActiveState,SubState,UnitFileState,MainPID,FragmentPath'])
        units[name]={'exit_code':p.returncode,'values':dict(line.split('=',1)for line in p.stdout.decode().splitlines()if '='in line)}
    running=command(['/usr/bin/systemctl','list-units','--type=service','--state=running','--no-legend','--plain','--no-pager'])
    route=command(['/usr/sbin/ip','-j','route','show'])
    # Packet counters change with normal SSH/CDN traffic; compare policy only.
    packet_filter=command(['/usr/sbin/nft','--stateless','list','ruleset'])
    relevant={}
    for name in ['/etc/sysctl.conf','/etc/ssh/sshd_config','/etc/sudoers','/etc/ld.so.cache','/etc/ld.so.preload']:
        p=Path(name);relevant[name]={'sha256':sha256(p.read_bytes()).hexdigest(),**meta(p)}if p.exists()else {'absent':True}
    for name in ['/etc/apparmor.d','/etc/sysctl.d','/etc/ssh/sshd_config.d','/etc/sudoers.d','/etc/systemd/system','/etc/netplan']:
        relevant.update(hashes(name))
    release={}
    for name in ['/opt/bartosz-intelligence/current','/opt/bartosz-intelligence/release.json','/opt/bartosz-intelligence/manifest.json']:
        p=Path(name);release[name]=meta(p)
        if p.is_file()and not p.is_symlink():release[name]['sha256']=sha256(p.read_bytes()).hexdigest()
    current=Path('/opt/bartosz-intelligence/current')
    if current.is_dir():
        for p in current.iterdir():
            if p.is_file() and p.name.endswith(('.json','.sha256')):
                release[str(p)]={'sha256':sha256(p.read_bytes()).hexdigest(),**meta(p)}
    return {'schema':'ote-sandbox-host-state:1','boot_id':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
        'apparmor_enabled':Path('/sys/module/apparmor/parameters/enabled').read_text().strip(),
        'loaded_profiles':sorted(profiles),'configuration_files':relevant,'release':release,
        'sysctl':{p:Path(p).read_text().strip()for p in ['/proc/sys/kernel/unprivileged_userns_clone',
            '/proc/sys/kernel/apparmor_restrict_unprivileged_userns','/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined',
            '/proc/sys/user/max_user_namespaces']},
        'execution_account':{'uid':user.pw_uid,'gid':user.pw_gid,'groups':[g.gr_name for g in grp.getgrall()if c['account']in g.gr_mem],
            'sudo_query_exit':sudo.returncode,'sudo_query_sha256':sha256(sudo.stdout+sudo.stderr).hexdigest(),
            'sudo_denied':sudo_denied(sudo)},
        'units':units,'running_services':sorted(line.split()[0]for line in running.stdout.decode().splitlines()if line.split()),
        'route_sha256':sha256(route.stdout).hexdigest(),'route_exit_code':route.returncode,
        'firewall_sha256':sha256(packet_filter.stdout).hexdigest(),'firewall_exit_code':packet_filter.returncode,
        'firewall_fingerprint_mode':'STATELESS_NO_PACKET_COUNTERS',
        'target_paths':{p:meta(Path(p))for p in ['/opt/bartosz-intelligence/browser-runtimes',c['runtime_root'],c['apparmor_profile_path']]}}


if __name__=='__main__':
    c=CONFIG if 'CONFIG'in globals()else json.loads(Path(__file__).with_name('runtime.json').read_text())
    print(json.dumps(snapshot(c)))
