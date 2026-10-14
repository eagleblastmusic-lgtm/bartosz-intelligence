"""Repeatable strict preflight. Contains no install/profile-load operation."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import subprocess
from diagnose import ssh

HERE=Path(__file__).resolve().parent


def capture(key):
    c=json.loads((HERE/'runtime.json').read_text())
    command=ssh(key)
    command[-1]='env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -I -'
    source='CONFIG='+repr(c)+"\n__name__='observer'\n"+(HERE/'host-state.py').read_text()+'\n'+'''
result=snapshot(CONFIG)
result['test_temporary_paths_remaining']=[str(p)for pattern in ['ote-library-boundary-*','ote-loader-supervised-*','ote-sandbox-contracts-*']for p in Path('/tmp').glob(pattern)]
result['managed_browser_pids']=[]
for p in Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  if os.readlink(p/'exe')==CONFIG['executable']:result['managed_browser_pids'].append(int(p.name))
 except (FileNotFoundError,ProcessLookupError):pass
print(json.dumps(result))
'''
    run=subprocess.run(command,input=source.encode(),capture_output=True,timeout=45)
    if run.returncode:raise RuntimeError('HOST_SNAPSHOT_FAILED_'+sha256(run.stderr).hexdigest())
    return json.loads(run.stdout)


def write(out,name,value):
    (out/name).write_text(json.dumps(value,indent=2)+'\n',encoding='utf-8')


def main():
    p=argparse.ArgumentParser();p.add_argument('--key',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    args=p.parse_args();args.output.mkdir(parents=True,exist_ok=False)
    before=capture(args.key);write(args.output,'host-before.json',before)
    probe=args.output/'library-boundary.json'
    run=subprocess.run([__import__('sys').executable,'-B',str(HERE/'library-boundary-probe.py'),'--key',str(args.key),'--output',str(probe)],capture_output=True,timeout=130)
    after=capture(args.key);write(args.output,'host-after.json',after)
    keys=['boot_id','apparmor_enabled','loaded_profiles','configuration_files','release','sysctl','units','running_services',
        'route_sha256','route_exit_code','firewall_sha256','firewall_exit_code','firewall_fingerprint_mode','target_paths','execution_account']
    comparison={'schema':'ote-deployment-host-comparison:2','checks':{k:before[k]==after[k]for k in keys},
        'configuration_files_compared':len(before['configuration_files']),'loaded_profiles_before':len(before['loaded_profiles']),
        'loaded_profiles_after':len(after['loaded_profiles']),'ssh_new_connection':'PASS',
        'managed_browser_pids':after['managed_browser_pids'],'test_temporary_paths_remaining':after['test_temporary_paths_remaining'],
        'rollback':'NOT_REQUIRED_NO_INSTALLATION'}
    comparison['pass']=all(comparison['checks'].values())and not comparison['managed_browser_pids']and not comparison['test_temporary_paths_remaining']
    write(args.output,'host-comparison.json',comparison)
    result={'schema':'ote-deployment-preflight:1','owner_authorized_prepared_deployment':True,
        'host_integrity_pass':comparison['pass'],'loader_probe_pass':run.returncode==0,
        'deployment_allowed':False,'critical_requirement_8':'FAIL_DIRECT_ELF_LIBRARY_SELECTION',
        'SANDBOX_READINESS':'BLOCKED_PREFLIGHT_LIBRARY_BOUNDARY','LIVE_SOURCE_ACCESS':'BLOCKED_AUTHORIZATION',
        'security_configuration_applied':False,'accepted':False}
    write(args.output,'preflight.json',result);print(json.dumps(result))
    return 0 if result['host_integrity_pass']and result['loader_probe_pass']else 2


if __name__=='__main__':raise SystemExit(main())
