"""One owner-authorized Snap trial, explicit phases and exact-delta rollback.

Uses existing host snapshot, CDP/browser-check and supervisor. No production API.
Run on Oracle only from a root-owned packet using python3 -I. No global sysctl.
"""
import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import time

ROOT=Path('/root/bartosz-ote-snap-trial-20261014')
TRIAL=Path('/opt/bartosz-intelligence/browser-trial')
HOME=Path('/home/bartosz-browser')
ALLOWED={'chromium','core24','gnome-46-2404','mesa-2404','gtk-common-themes','cups','core26','bare'}
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'}
CGROUP_TRIAL=False
DEPLOYMENT=False


def require(ok,code):
    if not ok:raise RuntimeError(code)


def cmd(argv,timeout=20):
    p=subprocess.run(argv,env=ENV,capture_output=True,timeout=timeout)
    return {'argv':argv,'exit_code':p.returncode,'stdout':p.stdout.decode('utf-8','replace')[-65536:],'stderr':p.stderr.decode('utf-8','replace')[-8192:]}


def write(name,value):
    (ROOT/name).write_text(json.dumps(value,indent=2)+'\n')


def load(name):return json.loads((ROOT/name).read_text())


def snaps():
    state=json.loads(Path('/var/lib/snapd/state.json').read_text())
    return {n:{k:v.get(k)for k in ['current','active','type']}for n,v in state['data'].get('snaps',{}).items()}


def host():
    sys.path.insert(0,str(ROOT));import host_state
    return host_state.snapshot(load('runtime.json'))


def check_existing(before,after):
    for key in ['boot_id','sysctl','release','execution_account','units','route_sha256','firewall_sha256']:
        require(before[key]==after[key],'PREEXISTING_HOST_DRIFT:'+key)
    for name,row in before['configuration_files'].items():
        require(after['configuration_files'].get(name)==row,'PREEXISTING_CONFIG_DRIFT:'+name)


def preflight():
    before=host();initial=snaps()
    require('chromium'not in initial and not TRIAL.exists()and not HOME.exists(),'EXISTING_TEST_TARGET')
    try:pwd.getpwnam('bartosz-browser');raise RuntimeError('EXISTING_BROWSER_ACCOUNT')
    except KeyError:pass
    require(not(ALLOWED & initial.keys()),'PREEXISTING_SHARED_DEPENDENCY_REQUIRES_REVIEW')
    require(Path('/sys/fs/cgroup/cgroup.controllers').exists(),'CGROUP_V2_REQUIRED')
    require('memory'in Path('/sys/fs/cgroup/cgroup.controllers').read_text(),'MEMORY_CONTROLLER_REQUIRED')
    info=cmd(['/usr/bin/snap','info','chromium','--unicode=never'],40)
    require(info['exit_code']==0,'SNAP_METADATA_UNAVAILABLE')
    if DEPLOYMENT:
        approved=load('approved-snaps.json')
        require(initial.get('snapd',{}).get('current')=='28255','UNTESTED_SNAPD_REVISION')
        metadata={}
        for name,revision in approved.items():
            row=info if name=='chromium'else cmd(['/usr/bin/snap','info',name,'--unicode=never'],40)
            metadata[name]=row
            match=re.search(r'^\s*latest/stable:.*\((\d+)\)',row['stdout'],re.M)
            require(row['exit_code']==0 and match and match.group(1)==revision,'UNTESTED_STABLE_DEPENDENCY:'+name)
        write('approved-package-metadata.json',metadata)
    write('host-before.json',before);write('snaps-before.json',initial);write('snap-info.json',info)
    return {'status':'PREFLIGHT_PASS','initial_snaps':initial,'snapshot_files':len(before['configuration_files']),
        'approved_revision':3555,'memory_mib':768,'install_performed':False}


def install():
    require((ROOT/'host-before.json').exists(),'PREFLIGHT_REQUIRED')
    require(not(ROOT/'install-command.json').exists(),'ONE_INSTALL_ONLY')
    # Record before starting so an interrupted SSH operation cannot be replayed.
    write('install-command.json',{'state':'STARTED','revision':3555,'started_unix':time.time()})
    p=cmd(['/usr/bin/snap','install','chromium','--channel=latest/stable','--revision=3555'],600)
    current=snaps();initial=load('snaps-before.json');added=sorted(current.keys()-initial.keys())
    write('install-command.json',p);write('snaps-installed.json',current)
    return finish_install()


def finish_install():
    p=load('install-command.json');current=snaps();initial=load('snaps-before.json');added=sorted(current.keys()-initial.keys())
    if 'bare'in added:
        require('\nbase: bare\n'in Path('/snap/gtk-common-themes/current/meta/snap.yaml').read_text(),'BARE_DEPENDENCY_NOT_PROVEN')
    require(set(added)<=ALLOWED,'UNEXPECTED_SNAP_DEPENDENCY')
    if DEPLOYMENT:
        require({n:str(current[n]['current'])for n in added}==load('approved-snaps.json'),'UNTESTED_INSTALLED_DEPENDENCY_REVISIONS')
    require(all(current.get(n)==v for n,v in initial.items()),'EXISTING_SNAP_REVISION_CHANGED')
    services=cmd(['/usr/bin/snap','services']);write('services-installed.json',services)
    for app in ['cups.cupsd','cups.cups-browsed','mesa-2404.component-monitor']:
        if app.split('.')[0]in added:
            p2=cmd(['/usr/bin/snap','stop','--disable',app],45);write(app+'.disabled.json',p2)
            require(p2['exit_code']==0,'NEW_DEPENDENCY_SERVICE_STOP_FAILED:'+app)
    after=host();write('host-after-install.json',after);check_existing(load('host-before.json'),after)
    require(p['exit_code']==0 and current.get('chromium',{}).get('current')in {'3555',3555},'SNAP_INSTALL_FAILED')
    return {'status':'INSTALL_PASS','added_snaps':added,'services':services}


def setup():
    require(not TRIAL.exists()and not HOME.exists(),'TEST_TARGET_ALREADY_EXISTS')
    # A new high service UID avoids the executor account and any existing slice.
    occupied={a.pw_uid for a in pwd.getpwall()};uid=next(i for i in range(30000,30100)if i not in occupied)
    slice_file=Path('/etc/systemd/system'if DEPLOYMENT else'/run/systemd/system')/f'user-{uid}.slice'
    require(not slice_file.exists()and not Path(f'/run/systemd/system/user-{uid}.slice').exists(),'PREEXISTING_TEST_SLICE')
    p=cmd(['/usr/sbin/useradd','--uid',str(uid),'--user-group','--home-dir',str(HOME),'--shell','/usr/sbin/nologin','--no-create-home','bartosz-browser'])
    require(p['exit_code']==0,'ACCOUNT_CREATION_FAILED');a=pwd.getpwnam('bartosz-browser')
    write('test-account.json',{'uid':uid,'gid':a.pw_gid,'name':a.pw_name})
    HOME.mkdir(mode=0o700);os.chown(HOME,uid,a.pw_gid)
    path=HOME
    for part in ['snap','chromium','common','jobs']:
        path=path/part;path.mkdir(mode=0o700);os.chown(path,uid,a.pw_gid)
    TRIAL.mkdir(mode=0o755)
    manifest=load('packet-files.json')
    for name,row in manifest.items():
        source=ROOT/'packet'/name;require(sha256(source.read_bytes()).hexdigest()==row,'TEST_PACKET_HASH')
        target=TRIAL/name;target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(source,target);target.chmod(0o755 if name=='snap-entry.py'else 0o644)
    source=Path('/opt/bartosz-intelligence/runtime/node-24.21.0/bin/node')
    require(sha256(source.read_bytes()).hexdigest()=='0f8949d1028f6d61506b2d5bc57e7e6fe893d7b1997509b7847294fc9c616584','NODE_PIN_CHANGED')
    shutil.copyfile(source,TRIAL/'node');(TRIAL/'node').chmod(0o755)
    # Shared ancestor is necessary because Snap can create a sibling scope.
    slice_file.write_text('[Unit]\nDescription=Bartosz one-off Chromium memory boundary\n[Slice]\nMemoryAccounting=yes\nCPUAccounting=yes\nTasksAccounting=yes\nMemoryHigh=640M\nMemoryMax=768M\nMemorySwapMax=0\nCPUQuota=50%\nTasksMax=256\n')
    slice_file.chmod(0o644)
    p=cmd(['/usr/bin/systemctl','daemon-reload']);require(p['exit_code']==0,'RUNTIME_UNIT_RELOAD_FAILED')
    write('setup.json',{'uid':uid,'gid':a.pw_gid,'slice':'user-'+str(uid)+'.slice','slice_file':str(slice_file),
        'trial':str(TRIAL),'home':str(HOME),'persistent_service_added':False})
    return {'status':'SETUP_PASS','uid':uid,'memory_limit_bytes':805306368,'private_network':'one transient local-only flag'}


def uid_processes(uid):
    found=[]
    for p in Path('/proc').iterdir():
        if p.name.isdigit():
            try:
                if p.stat().st_uid==uid:found.append(int(p.name))
            except FileNotFoundError:pass
    return found


def status(pid):
    base=Path('/proc')/str(pid);values={}
    for line in(base/'status').read_text().splitlines():
        k,_,v=line.partition(':')
        if k in {'Uid','Gid','CapEff','CapPrm','CapInh','CapAmb','NoNewPrivs','Seccomp','Seccomp_filters','NSpid','VmRSS'}:values[k]=v.strip()
    return {'pid':pid,'exe':os.readlink(base/'exe'),'argv':(base/'cmdline').read_bytes().decode('utf-8','replace').split('\0'),
        'apparmor':(base/'attr/current').read_text().strip(),'namespaces':{n:os.readlink(base/'ns'/n)for n in ['user','pid','net']},
        'uid_map':(base/'uid_map').read_text().strip(),'cgroup':(base/'cgroup').read_text().strip(),**values}


def has_flag(argv, flag):
    # Chromium can rewrite /proc/cmdline into one space-delimited process title.
    return any(re.search(r'(?:^|\s)'+re.escape(flag)+r'(?:\s|$)',arg)for arg in argv)


def cgroup_sample(cg):
    return {n:(cg/n).read_text().strip()for n in ['memory.current','memory.peak','memory.max','memory.events','memory.swap.max','cpu.stat','cpu.max','pids.max']}


def group_pids(cg):
    result=set()
    for f in cg.rglob('cgroup.procs'):
        try:result.update(int(p)for p in f.read_text().split())
        except FileNotFoundError:pass
    return result


def test(native=False, source_fix=False, player_probe=False, publisher_name=None, availability_probe=False):
    cfg=load('setup.json');uid=cfg['uid'];unit='bartosz-ote-snap-trial.service'
    if publisher_name:
        require(DEPLOYMENT and publisher_name in {'github','mit'}and(ROOT/'deployment.json').exists()and not(ROOT/('publisher-'+publisher_name+'-started.json')).exists(),'ONE_EXPERIMENT_PER_PUBLISHER_SOURCE_ONLY')
    elif native:
        require(DEPLOYMENT and(ROOT/'deployment.json').exists(),'READINESS_REQUIRED_BEFORE_NATIVE')
        if availability_probe:
            require(load('native3-capture-result.json').get('failure_code')=='PLAYER_LOGIN_REQUIRED_WITHOUT_ID'and not(ROOT/'native-mit-started.json').exists(),'ONE_OTHER_AUTHOR_AVAILABILITY_HYPOTHESIS_ONLY')
        elif player_probe:
            require(load('native2-capture-result.json').get('failure_code')=='NATIVE_DEADLINE'and not(ROOT/'native-player-probe-started.json').exists(),'ONE_PLAYER_STATE_HYPOTHESIS_ONLY')
        elif source_fix:
            require(load('native1-capture-result.json').get('failure_code')=='WATCH_HTTP_401'and not(ROOT/'native-fix-started.json').exists(),'ONE_DOCUMENT_CLASSIFICATION_FIX_ONLY')
        else:require(not(ROOT/'native-started.json').exists(),'ONE_NATIVE_EXPERIMENT_AFTER_READINESS_ONLY')
    retry=not native and not publisher_name and(ROOT/'test-started.json').exists()
    require(not(CGROUP_TRIAL and retry),'ONE_CGROUP_BROWSER_EXPERIMENT_ONLY')
    require(not retry or((ROOT/'supported-fix.json').exists()and not(ROOT/'retry-started.json').exists()),'ONE_TEST_AND_ONE_SIMPLE_RETRY_ONLY')
    require(not uid_processes(uid),'BROWSER_UID_ALREADY_ACTIVE')
    attempt='publisher-'+publisher_name if publisher_name else'native-mit'if availability_probe else'native3'if player_probe else'native2'if source_fix else'native1'if native else'attempt2'if retry else'attempt1'
    marker=attempt+'-started.json'if publisher_name or availability_probe else'native-player-probe-started.json'if player_probe else'native-fix-started.json'if source_fix else'native-started.json'if native else'retry-started.json'if retry else'test-started.json'
    write(marker,{'started_unix':time.time(),'unit':unit,'source_fix':source_fix,'player_probe':player_probe})
    if retry or CGROUP_TRIAL:
        if retry:
            reset=cmd(['/usr/bin/systemctl','reset-failed',unit]);require(reset['exit_code']==0,'RETRY_UNIT_RESET_FAILED')
        manager=cmd(['/usr/bin/systemctl','start',f'user@{uid}.service'])
        write('user-manager-start.json',manager);require(manager['exit_code']==0,'SUPPORTED_USER_MANAGER_START_FAILED')
        require(Path(f'/run/user/{uid}').exists(),'DEDICATED_RUNTIME_DIRECTORY_MISSING')
    job=HOME/'snap/chromium/common/jobs';out=job/attempt;out.mkdir(mode=0o700);os.chown(out,uid,cfg['gid'])
    cg=Path('/sys/fs/cgroup/user.slice')/cfg['slice']
    if CGROUP_TRIAL:
        boundary=cgroup_sample(cg)
        require(boundary['memory.max']=='805306368'and boundary['memory.swap.max']=='0'and boundary['cpu.max']=='50000 100000','KERNEL_BOUNDARY_REQUIRED')
        write('kernel-boundary-before.json',boundary)
    executable=str(TRIAL/'snap-entry.py')if retry or CGROUP_TRIAL else'/snap/bin/chromium'
    node_args=[str(TRIAL/'transcript-engine.mjs'),'native','aircAruvnKk',str(TRIAL/'native-source.json'),str(out/'capture')]if native else[str(TRIAL/'diagnostic-run.mjs'),str(TRIAL/'fixture-root'),executable,str(out)]
    if availability_probe:
        source_config=TRIAL/'native-mit-source.json'
        source_config.write_text(json.dumps({'schema':'ote-source:1','diagnostic_video_id':'nykOeWgQcHM','browser_executable':executable,'sandbox':True})+'\n');source_config.chmod(0o644)
        node_args=[str(TRIAL/'transcript-engine.mjs'),'native','nykOeWgQcHM',str(source_config),str(out/'capture')]
    if publisher_name:
        source_config=TRIAL/('publisher-'+publisher_name+'.json');source_id=json.loads(source_config.read_text())['diagnostic_video_id']
        node_args=[str(TRIAL/'transcript-engine.mjs'),'publisher',source_id,str(source_config),str(out/'capture')]
    # No custom network plumbing. This one flag prevents unsolicited public
    # traffic during the authorized local harness, including startup background.
    command=['/usr/bin/systemd-run','--unit='+unit,'--slice='+cfg['slice'],'--property=User=bartosz-browser',
        '--property=Group=bartosz-browser','--property=UMask=0077',*([]if native or publisher_name else['--property=PrivateNetwork=yes']),
        '--property=RuntimeMaxSec=100s','--property=TimeoutStopSec=10s','--property=KillMode=control-group',
        '--property=Restart=no','--property=MemoryMax=768M','--property=MemorySwapMax=0','--property=TasksMax=256',
        '/usr/bin/env','-i','PATH=/usr/bin:/bin','HOME='+str(HOME),'TMPDIR='+str(job),'LANG=C.UTF-8',
        '/usr/bin/python3','-I',str(TRIAL/'supervise.py'),'--output',str(out/'resources.json'),'--memory-mib','768','--timeout','100',
        *(['--memory-cgroup',str(cg)]if CGROUP_TRIAL else[]),'--',
        str(TRIAL/'node'),'--max-old-space-size=192',*node_args]
    start=time.monotonic();p=cmd(command);write(attempt+'-unit-start.json',p);require(p['exit_code']==0,'TRANSIENT_TEST_START_FAILED')
    observations=[];seen=set();cg_samples=[];all_seen={};pid_samples=[];pss_sample=None
    deadline=start+110
    while time.monotonic()<deadline:
        members=group_pids(cg)if cg.exists()else set()
        account_pids=set(uid_processes(uid))
        for pid in account_pids|members:
            try:
                s=status(pid)
                if CGROUP_TRIAL:
                    require('/user.slice/'+cfg['slice']+'/'in s['cgroup']or s['cgroup'].endswith('/user.slice/'+cfg['slice']),'PROCESS_ESCAPED_MEMORY_PARENT')
                    all_seen[pid]=s
                if has_flag(s['argv'],'--type=renderer')or('/chromium'in s['exe']and has_flag(s['argv'],'--headless=new')):
                    key=(pid,s['apparmor'])
                    if key not in seen:observations.append(s);seen.add(key)
                    require(not has_flag(s['argv'],'--no-sandbox'),'SANDBOX_DISABLED')
                    require('/user.slice/'+cfg['slice']+'/'in s['cgroup'],'SNAP_ESCAPED_MEMORY_PARENT')
            except(FileNotFoundError,ProcessLookupError):pass
        if cg.exists():
            sample=cgroup_sample(cg);cg_samples.append(sample)
            if CGROUP_TRIAL:
                require(sample['memory.max']=='805306368'and sample['memory.swap.max']=='0'and sample['cpu.max']=='50000 100000','KERNEL_BOUNDARY_CHANGED')
                pid_samples.append({'uid_pids':sorted(account_pids),'cgroup_pids':sorted(members)})
                rss=sum(int(all_seen[p].get('VmRSS','0 kB').split()[0])for p in members if p in all_seen)*1024
                if rss>805306368 and pss_sample is None:
                    rollups={};rollup_errors={}
                    for pid in members:
                        try:
                            lines=Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines()
                            rollups[pid]={k:int(v.split()[0])*1024 for line in lines if ':'in line for k,_,v in[line.partition(':')]if k in {'Rss','Pss','Shared_Clean','Shared_Dirty','Private_Clean','Private_Dirty'}}
                        except OSError as error:rollup_errors[pid]=type(error).__name__
                    pss_sample={'cgroup_memory_current':sample['memory.current'],'processes':rollups,'unavailable_pids':rollup_errors,
                        'sum_rss_bytes':sum(r['Rss']for r in rollups.values()),'sum_pss_bytes':sum(r['Pss']for r in rollups.values())}
        active=cmd(['/usr/bin/systemctl','show',unit,'--property=ActiveState','--value'])['stdout'].strip()
        if active in {'inactive','failed'}:break
        time.sleep(0.05)
    result={'observations':observations,'cgroup_samples':cg_samples,'elapsed_ms':round((time.monotonic()-start)*1000),
        'unit':cmd(['/usr/bin/systemctl','show',unit,'--property=ActiveState,SubState,Result,ExecMainStatus,MemoryPeak,CPUUsageNSec']),
        'journal':cmd(['/usr/bin/journalctl','-u',unit,'--no-pager','-n','70','-o','cat']),
        'remaining_uid_pids':uid_processes(uid),'host_net':os.readlink('/proc/1/ns/net'),
        'all_observed_processes':list(all_seen.values()),'pid_samples':pid_samples,'shared_memory_sample':pss_sample}
    write(attempt+'-observer.json',result)
    # Stop all processes of this newly created UID before reading its receipts;
    # do not let an untrusted child mutate a pathname while root copies data.
    result['cleanup']=stop_test()
    require(out.resolve()==out,'TEST_OUTPUT_PARENT_ALIAS')
    for folder in [out,*([out/'capture']if(native or publisher_name)and(out/'capture').exists()else[])]:
        require(folder.resolve()==folder,'TEST_RECEIPT_DIRECTORY_ALIAS')
        directory=os.open(folder,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        for f in folder.iterdir():
            if f.suffix not in {'.json','.txt','.raw'}:continue
            fd=os.open(f.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
            try:
                s=os.fstat(fd)
                require(stat.S_ISREG(s.st_mode)and s.st_uid==uid and s.st_nlink==1 and s.st_size<8388608,'UNSAFE_TEST_RECEIPT')
                with os.fdopen(fd,'rb',closefd=False)as stream:data=stream.read(8388609)
                require(len(data)==s.st_size,'TEST_RECEIPT_SIZE_CHANGED')
                (ROOT/(attempt+('-capture-'if folder!=out else'-')+f.name)).write_bytes(data)
            finally:os.close(fd)
        os.close(directory)
    write(attempt+'-observer.json',result)
    return result


def stop_test():
    if not(ROOT/'setup.json').exists():return {'setup_absent':True}
    c=load('setup.json');actions=[]
    actions.append(cmd(['/usr/bin/systemctl','stop','bartosz-ote-snap-trial.service'],20))
    actions.append(cmd(['/usr/bin/systemctl','stop',c['slice']],20))
    for pid in uid_processes(c['uid']):
        try:os.kill(pid,signal.SIGKILL)
        except ProcessLookupError:pass
    time.sleep(0.2)
    result={'actions':actions,'remaining_uid_pids':uid_processes(c['uid'])};write('cleanup.json',result)
    require(not result['remaining_uid_pids'],'TEST_PROCESSES_REMAIN')
    return result


def memory_check():
    """One small kernel OOM control; no browser launch and no larger RAM budget."""
    require(CGROUP_TRIAL and(ROOT/'attempt1-observer.json').exists()and not(ROOT/'memory-check.json').exists(),'ONE_POST_BROWSER_MEMORY_CONTROL_ONLY')
    cfg=load('setup.json');require(not uid_processes(cfg['uid']),'MEMORY_CONTROL_UID_BUSY')
    unit='bartosz-ote-snap-trial.service';cg=Path('/sys/fs/cgroup/user.slice')/cfg['slice']
    write('memory-check.json',{'state':'STARTED','leaf_limit_bytes':33554432,'parent_limit_bytes':805306368})
    cmd(['/usr/bin/systemctl','reset-failed',unit])
    start=cmd(['/usr/bin/systemd-run','--unit='+unit,'--slice='+cfg['slice'],'--property=User=bartosz-browser',
        '--property=Group=bartosz-browser','--property=MemoryMax=32M','--property=MemorySwapMax=0',
        '--property=OOMPolicy=kill','--property=RuntimeMaxSec=10s','--property=TimeoutStopSec=5s','--property=PrivateNetwork=yes',
        '/usr/bin/python3','-I','-c','x=bytearray(128*1024*1024)'])
    require(start['exit_code']==0,'MEMORY_CONTROL_START_FAILED')
    samples=[];deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        if cg.exists():samples.append(cgroup_sample(cg))
        state=cmd(['/usr/bin/systemctl','show',unit,'--property=ActiveState','--value'])['stdout'].strip()
        if state in {'inactive','failed'}:break
        time.sleep(0.05)
    state=cmd(['/usr/bin/systemctl','show',unit,'--property=ActiveState,Result,ExecMainCode,ExecMainStatus,MemoryMax,MemorySwapMax,ControlGroup'])
    result={'unit_start':start,'unit':state,'cgroup_samples':samples,'journal':cmd(['/usr/bin/journalctl','-u',unit,'--no-pager','-n','15','-o','cat'])}
    result['cleanup']=stop_test();write('memory-check.json',result)
    require('Result=oom-kill'in state['stdout']and 'MemoryMax=33554432'in state['stdout']and 'MemorySwapMax=0'in state['stdout'],'KERNEL_MEMORY_CONTROL_FAILED')
    return result


def retain():
    """Accept the single smoke test and leave the browser installed, idle."""
    require(DEPLOYMENT and not(ROOT/'deployment.json').exists(),'ONE_DEPLOYMENT_ACCEPTANCE_ONLY')
    cfg=load('setup.json');browser=load('attempt1-browser.json');resource=load('attempt1-resources.json');observer=load('attempt1-observer.json')
    require(browser['status']=='PASS'and browser['test_count']==1 and browser['records'][0]['cue_count']==286,'LOCAL_PANEL_NOT_READY')
    require(resource['category']=='NONE'and resource['exit_code']==0 and resource['descendants_remaining']==0,'SUPERVISOR_NOT_READY')
    require(resource['memory_enforcement']=='LINUX_CGROUP_V2_KERNEL_HARD_RSS_DIAGNOSTIC','WRONG_MEMORY_ENFORCEMENT')
    require(not uid_processes(cfg['uid']),'BROWSER_PROCESSES_REMAIN')
    main=next(p for p in observer['observations']if p['exe'].endswith('/chromium-browser/chrome')and not re.search(r'(?:^|\s)--type=',' '.join(p['argv'])))
    renderers=[p for p in observer['all_observed_processes']if has_flag(p['argv'],'--type=renderer')]
    require(renderers,'RENDERER_PROOF_REQUIRED')
    for p in renderers:
        require(p['apparmor']=='snap.chromium.chromium (enforce)'and p['NoNewPrivs']=='1'and p['Seccomp']=='2'and int(p['Seccomp_filters'])>int(main['Seccomp_filters']),'RENDERER_SANDBOX_NOT_READY')
        require(all(p['namespaces'][n]!=main['namespaces'][n]for n in ['user','pid','net']),'RENDERER_NAMESPACE_NOT_READY')
        require(all(int(p[n],16)==0 for n in ['CapInh','CapPrm','CapEff','CapAmb']),'RENDERER_CAPABILITY_LEAK')
    after=host();before=load('host-before.json');check_existing(before,after)
    installed=load('host-after-install.json')['configuration_files']
    approved=load('approved-snaps.json')
    mounts={'snap-'+n.replace('-',r'\x2d')+'-'+v+'.mount'for n,v in approved.items()}
    snap_files={prefix+n for prefix in ['/etc/systemd/system/','/etc/systemd/system/multi-user.target.wants/','/etc/systemd/system/snapd.mounts.target.wants/']for n in mounts}
    snap_files.update('/etc/systemd/system/snap.'+n+'.service'for n in ['chromium.daemon','cups.cupsd','cups.cups-browsed','mesa-2404.component-monitor'])
    require(set(installed)-set(before['configuration_files'])==snap_files,'UNEXPECTED_SNAP_CONFIGURATION')
    require(set(after['configuration_files'])-set(installed)=={cfg['slice_file']},'UNEXPECTED_PERSISTENT_CONFIGURATION')
    require(all(after['configuration_files'].get(n)==v for n,v in installed.items()),'INSTALLED_CONFIGURATION_DRIFT')
    require(after['running_services']==before['running_services'],'UNEXPECTED_RUNNING_SERVICE')
    require(all(snaps().get(n)==v for n,v in load('snaps-before.json').items()),'PREEXISTING_SNAP_DRIFT')
    write('host-after-success.json',after)
    result={'status':'PASS_OFFLINE','CHROMIUM_INSTALLED':True,'CDP_READY':'PASS_OFFLINE','SANDBOX_READY':'PASS_OFFLINE','RESOURCE_LIMIT':'PASS_OFFLINE',
        'LIVE_TRANSCRIPT_ACQUISITION':'NOT_TESTED','PRODUCTION_GO_NO_GO':'NO_GO','accepted':False,
        'browser_version':browser['records'][0]['diagnostics']['browser_version'],'cue_count':286,'renderer_count':len(renderers),
        'resource_receipt':'attempt1-resources.json','retained_snaps':snaps(),'account':cfg,'remaining_uid_pids':[],
        'persistent_config_added':cfg['slice_file'],'persistent_worker_added':False,'rollback_performed':False}
    write('deployment.json',result);return result


def rollback():
    stop_test();initial=load('snaps-before.json');current=snaps();added=current.keys()-initial.keys()
    require(added<=ALLOWED,'UNEXPECTED_SNAP_STOP_MANUAL_REVIEW')
    actions=[]
    for n in ['chromium','cups','gnome-46-2404','mesa-2404','gtk-common-themes','core26','core24','bare']:
        if n in added:
            p=cmd(['/usr/bin/snap','remove','--purge',n],120);actions.append(p)
            require(p['exit_code']==0,'SNAP_ROLLBACK_DEPENDENCY_REFUSED:'+n)
    require(snaps()==initial,'PREEXISTING_SNAP_STATE_CHANGED')
    if(ROOT/'setup.json').exists():
        c=load('setup.json');sf=Path(c['slice_file'])
        require(sf.parent==Path('/etc/systemd/system'if DEPLOYMENT else'/run/systemd/system')and sf.name==c['slice'],'RUNTIME_SLICE_ROLLBACK_PATH')
        sf.unlink(missing_ok=True);actions.append(cmd(['/usr/bin/systemctl','daemon-reload']))
        actions.append(cmd(['/usr/bin/systemctl','reset-failed','bartosz-ote-snap-trial.service']))
        # Preserve all public trial files root-only; no recursive deletion.
        TRIAL.chmod(0o700);HOME.chmod(0o700);os.chown(HOME,0,0)
        actions.append(cmd(['/usr/sbin/userdel','bartosz-browser']))
        actions.append(cmd(['/usr/sbin/groupdel','bartosz-browser']))
    after=host();write('host-after-rollback.json',after);check_existing(load('host-before.json'),after)
    if CGROUP_TRIAL:
        before=load('host-before.json');extra=set(after['loaded_profiles'])-set(before['loaded_profiles'])
        require(not(set(before['loaded_profiles'])-set(after['loaded_profiles'])),'PREEXISTING_PROFILE_REMOVED')
        names=sorted(line.rsplit(' (',1)[0]for line in extra)
        for name in names:
            require(name.startswith(('snap.chromium.','snap.cups.','snap.mesa-2404.'))or name in {'snap-update-ns.chromium','snap-update-ns.cups','snap-update-ns.mesa-2404'},'UNEXPECTED_LOADED_PROFILE')
            require(not Path('/var/lib/snapd/apparmor/profiles',name).exists(),'PROFILE_FILE_STILL_EXISTS')
        active=[]
        for p in Path('/proc').iterdir():
            if p.name.isdigit():
                try:
                    if (p/'attr/current').read_text().strip()in extra:active.append(int(p.name))
                except(FileNotFoundError,ProcessLookupError,PermissionError):pass
        require(not active,'NEW_PROFILE_STILL_ACTIVE')
        if names:
            text='abi <abi/4.0>,\n'+''.join('profile '+json.dumps(n)+' {}\n'for n in names)
            p=subprocess.run(['/usr/sbin/apparmor_parser','--remove','--skip-cache'],input=text.encode(),capture_output=True,timeout=30,env=ENV)
            write('policy-cleanup.json',{'exit_code':p.returncode,'removed_only_new_profile_names':names,'active_processes':active,'stderr':p.stderr.decode()})
            require(p.returncode==0,'NEW_PROFILE_REMOVAL_FAILED')
        after=host();write('host-after-rollback.json',after)
    require(after['loaded_profiles']==load('host-before.json')['loaded_profiles'],'APPARMOR_ROLLBACK_DRIFT')
    require(after['running_services']==load('host-before.json')['running_services'],'PREEXISTING_SERVICE_DRIFT')
    require(after['configuration_files']==load('host-before.json')['configuration_files'],'CONFIGURATION_ROLLBACK_DRIFT')
    result={'status':'ROLLBACK_PASS','actions':actions,'snaps_restored':True,'host_existing_unchanged':True,
        'retained_root_only_evidence':[str(ROOT),str(TRIAL),str(HOME)]}
    write('rollback.json',result);return result


def main():
    global ROOT,TRIAL,HOME,CGROUP_TRIAL,DEPLOYMENT
    p=argparse.ArgumentParser();p.add_argument('phase',choices=['preflight','install','finish_install','setup','test','native','native_fix','native_probe','native_mit','publisher_github','publisher_mit','memory_check','stop','retain','rollback','state']);p.add_argument('--owner-authorized',action='store_true');mode=p.add_mutually_exclusive_group();mode.add_argument('--cgroup-trial',action='store_true');mode.add_argument('--deployment',action='store_true');a=p.parse_args()
    DEPLOYMENT=a.deployment;CGROUP_TRIAL=a.cgroup_trial or DEPLOYMENT
    if CGROUP_TRIAL:
        ROOT=Path('/root/bartosz-ote-snap-cgroup-20261014');TRIAL=Path('/opt/bartosz-intelligence/browser-cgroup-trial');HOME=Path('/home/bartosz-browser-cgroup')
    if DEPLOYMENT:
        ROOT=Path('/root/bartosz-ote-chromium-deployment-20261014');TRIAL=Path('/opt/bartosz-intelligence/browser-runtime');HOME=Path('/home/bartosz-browser-runtime')
    require(a.owner_authorized and os.geteuid()==0 and sys.flags.isolated,'OWNER_ROOT_ISOLATED_REQUIRED')
    for entry in [*reversed(ROOT.parents),ROOT,ROOT/'snap-trial.py']:
        m=entry.lstat();require(not stat.S_ISLNK(m.st_mode)and m.st_uid==0 and not m.st_mode&0o022,'ROOT_PACKET_REQUIRED')
    value={'state':lambda:{'host':host(),'snaps':snaps()},'stop':stop_test,'native':lambda:test(True),'native_fix':lambda:test(True,True),
        'native_probe':lambda:test(True,False,True),'native_mit':lambda:test(native=True,availability_probe=True),'publisher_github':lambda:test(publisher_name='github'),'publisher_mit':lambda:test(publisher_name='mit')}.get(a.phase,globals().get(a.phase))()
    print(json.dumps(value))


if __name__=='__main__':
    try:main()
    except Exception as e:
        print(json.dumps({'status':'FAIL','code':str(e)if isinstance(e,RuntimeError)else type(e).__name__,'accepted':False}));raise SystemExit(2)
