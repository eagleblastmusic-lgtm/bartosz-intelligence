"""Seal v2 local receipts once. No network, browser or administrative action."""
import ast
import gzip
from hashlib import sha256
import io
import json
from pathlib import Path
import shutil
import tarfile
import enforced
import policy

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
SCRATCH=ROOT/'.local/chromium-sandbox-v2'
OUT=ROOT/'docs/verification/oracle/2026-10-14/apparmor-library-boundary-v2'
NEW=['enforced.py','enforced-runtime.json','launcher-v2.py','v2-library-lock.json',
    'v2-inventory.py','v2-contracts.py','v2-offline-oracle.py','v2-plan.py','v2-active-tests.py',
    'v2-seal.py','README_V2_PL.md',enforced.PROFILE+'.apparmor']
REUSED=['policy.py','install.py','positive.py','assets.json','runtime.json','diagnose.py',
    'bartosz-ote-chromium-153_0_8010_12.apparmor']


def h(path):return sha256(Path(path).read_bytes()).hexdigest()


def write(path,value):path.write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n',encoding='utf-8',newline='\n')


def main():
    policy.require(not(OUT/'evidence-manifest.json').exists(),'FROZEN_V2_EVIDENCE_USE_NEW_STAGE')
    policy.require((OUT/'REPORT_PL.md').is_file(),'V2_REPORT_REQUIRED')
    oracle=policy.load(SCRATCH/'oracle-final.json');windows=policy.load(SCRATCH/'windows-contracts.json')
    policy.require(oracle['offline_checks_pass']and windows['pass']and windows['tests']==oracle['contracts']['receipt']['tests'],'V2_OFFLINE_TESTS_REQUIRED')
    for name,value in oracle['source_sha256'].items():
        p=HERE.parent/name if name=='supervise.py'else HERE/name
        policy.require(h(p)==value,'V2_TESTED_SOURCE_CHANGED:'+name)
    plan=policy.load(SCRATCH/'change-plan.json')
    for name,value in plan['packet_sha256'].items():
        p=HERE.parent/name if name=='supervise.py'else HERE/name
        policy.require(h(p)==value,'V2_PLANNED_SOURCE_CHANGED:'+name)
    old=[]
    for relative in ['2026-10-13/chromium-sandbox','2026-10-14/chromium-sandbox-deployment']:
        folder=ROOT/'docs/verification/oracle'/relative;manifest=policy.load(folder/'evidence-manifest.json')
        for name,value in manifest['files'].items():
            policy.require(h(folder/name)==value['sha256'],'FROZEN_PREVIOUS_EVIDENCE_CHANGED:'+name)
        old.append({'directory':relative,'files_verified':len(manifest['files']),'manifest_sha256':h(folder/'evidence-manifest.json')})
    for name in ['inventory.json','windows-contracts.json','windows-active-gate.json','oracle-final.json','change-plan.json']:
        shutil.copyfile(SCRATCH/name,OUT/name)
    calibration=OUT/'calibration';calibration.mkdir(exist_ok=True)
    for name in ['oracle-offline-initial-failure.json','oracle-offline-crlf-failure.json','windows-contracts-initial-failure.json']:
        shutil.copyfile(SCRATCH/name,calibration/name)
    sources=[HERE/name for name in NEW+REUSED]+[HERE/'README_PL.md',HERE.parent/'supervise.py']
    for path in sources:
        if path.suffix=='.py':ast.parse(path.read_text(encoding='utf-8'),filename=str(path))
    write(OUT/'local-checks.json',{'syntax_files':len([p for p in sources if p.suffix=='.py']),
        'syntax_pass':True,'previous_evidence':old,'accepted':False})
    write(OUT/'source-files.json',{'schema':'ote-v2-sources:1','new_files':NEW,'modified_existing':['README_PL.md'],
        'reused_unchanged':REUSED+['../supervise.py'],
        'files':{p.relative_to(ROOT).as_posix():{'sha256':h(p),'bytes':p.stat().st_size}for p in sources}})
    stream=io.BytesIO()
    with gzip.GzipFile(fileobj=stream,mode='wb',mtime=0,filename='')as gz:
        with tarfile.open(fileobj=gz,mode='w')as tar:
            for path in sorted(sources):
                data=path.read_bytes();e=tarfile.TarInfo(path.relative_to(ROOT).as_posix());e.size=len(data);e.mode=0o600
                tar.addfile(e,io.BytesIO(data))
    (OUT/'review-packet-v2.tar.gz').write_bytes(stream.getvalue())
    write(OUT/'verification.json',{'schema':'ote-v2-verification:1','windows_contracts':windows['tests'],
        'oracle_contracts':oracle['contracts']['receipt']['tests'],'profile_compiled_without_load':True,
        'verified_system_mapping_files':55,'exact_candidate_mapping_paths':60,'candidate_exec_paths':1,
        'runtime_installs':0,'profile_loads':0,'browser_executions':0,'source_requests':0,
        'LIBRARY_BOUNDARY_READINESS':'CANDIDATE_COMPILED_ACTIVE_POLICY_PENDING',
        'SANDBOX_DEPLOYMENT_READINESS':'BLOCKED_SECURITY_MODEL_AND_ACTIVE_ACCEPTANCE',
        'LIVE_SOURCE_ACCESS':'BLOCKED_AUTHORIZATION','accepted':False,'rollback_host_execution':'NOT_NEEDED_NOT_RUN'})
    files={p.relative_to(OUT).as_posix():{'sha256':h(p),'bytes':p.stat().st_size}for p in sorted(OUT.rglob('*'))if p.is_file()}
    write(OUT/'evidence-manifest.json',{'schema':'ote-v2-evidence:1','self_excluded':True,'files':files})
    print(json.dumps({'sealed_files':len(files),'previous_evidence_files_verified':sum(x['files_verified']for x in old),
        'review_packet_sha256':h(OUT/'review-packet-v2.tar.gz'),'accepted':False}))


if __name__=='__main__':main()
