"""Seal existing receipts and reviewed files locally; no SSH or host mutation."""
import ast
import difflib
import gzip
from hashlib import sha256
import io
import json
from pathlib import Path
import shutil
import tarfile
import policy
import prepare

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
SCRATCH=ROOT/'.local/chromium-sandbox'
OUT=ROOT/'docs/verification/oracle/2026-10-13/chromium-sandbox'


def write(name,value):
    (OUT/name).write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')


def main():
    if (OUT/'evidence-manifest.json').exists():
        raise SystemExit('FROZEN_PREPARATION_EVIDENCE_EXISTS_USE_NEW_STAGE_DIRECTORY')
    OUT.mkdir(parents=True,exist_ok=True)
    receipts=['diagnosis.json','windows-contracts.json','windows-contracts-initial-failure.json',
        'windows-contracts-rollback-harness-failure.json','windows-positive-gate.json','oracle-offline.json',
        'change-plan.json','environment-build.json','static-checks.json']
    for name in receipts:shutil.copyfile(SCRATCH/name,OUT/name)
    c=policy.load(HERE/'runtime.json');assets=policy.load(HERE/'assets.json')
    archive=SCRATCH/'chrome-headless-shell-linux-arm64.zip'
    blob=archive.read_bytes()
    inspected=prepare.inspect_archive(c,blob)
    assert inspected==assets
    write('artifact-inspection.json',{'status':'PASS_ARTIFACT_INSPECTION_ONLY','archive_url':c['archive_url'],
        'archive_sha256':sha256(blob).hexdigest(),'archive_bytes':len(blob),'executable_sha256':c['executable_sha256'],
        'elf_class':'ELF64_LE','elf_machine':183,'files':len(assets['files']),
        'uncompressed_bytes':sum(v['bytes']for v in assets['files'].values()),
        'vendor_signature_verified':False,'browser_executions':0,'accepted':False})
    old=ROOT/'docs/verification/oracle/2026-10-13/original-transcript-engine/prototype.tar.gz'
    with tarfile.open(old,'r:gz')as tar:before=tar.extractfile('tools/transcript-engine/browser.ts').read()
    path='tools/transcript-engine/browser.ts';after=(ROOT/path).read_bytes()
    delta=list(difflib.unified_diff(before.decode().splitlines(),after.decode().splitlines(),fromfile='archived/browser.ts',tofile=path,lineterm=''))
    assert [line[1:] for line in delta if line.startswith('-')and not line.startswith('---')]==["              'LD_LIBRARY_PATH',"]
    assert not [line for line in delta if line.startswith('+')and not line.startswith('+++')]
    write('client-change.json',{'file':path,'historical_archive_sha256':sha256(old.read_bytes()).hexdigest(),
        'before_sha256':sha256(before).hexdigest(),'after_sha256':sha256(after).hexdigest(),
        'unified_diff':delta,'production_executor_modified_by_this_task':False})
    source_files=[p for p in HERE.iterdir()if p.is_file()]
    for p in source_files:
        if p.suffix=='.py':ast.parse(p.read_text(encoding='utf-8'),filename=str(p))
    bodies={p.name:p.read_bytes()for p in source_files}
    stream=io.BytesIO()
    with gzip.GzipFile(fileobj=stream,mode='wb',mtime=0,filename='')as gz:
        with tarfile.open(fileobj=gz,mode='w')as tar:
            for name,body in sorted(bodies.items()):
                entry=tarfile.TarInfo(name);entry.size=len(body);entry.mode=0o600;tar.addfile(entry,io.BytesIO(body))
    packet=stream.getvalue();(OUT/'review-packet.tar.gz').write_bytes(packet)
    write('source-files.json',{'schema':'ote-sandbox-sources:1',
        'files':{p.relative_to(ROOT).as_posix():sha256(p.read_bytes()).hexdigest()for p in sorted(source_files)+[ROOT/path]},
        'review_packet_sha256':sha256(packet).hexdigest(),'review_packet_files':len(bodies),
        'excluded_browser_zip':True,'excluded_secrets':True})
    windows=policy.load(OUT/'windows-contracts.json');oracle=policy.load(OUT/'oracle-offline.json')
    for name,h in oracle['input_hashes'].items():
        actual=SCRATCH/name if name=='environment-check.mjs'else HERE/name
        assert sha256(actual.read_bytes()).hexdigest()==h,'TESTED_SOURCE_CHANGED:'+name
    plan=policy.load(OUT/'change-plan.json')
    for name,h in plan['packet_hashes'].items():assert sha256((HERE/name).read_bytes()).hexdigest()==h
    assert windows['pass']and oracle['pass']and windows['tests']==oracle['contracts']['receipt']['tests']==40
    assert policy.load(OUT/'static-checks.json')['pass']
    write('verification.json',{'schema':'ote-sandbox-verification:1','offline_checks':'PASS',
        'windows_security_contracts':windows['tests'],'oracle_security_contracts':oracle['contracts']['receipt']['tests'],
        'profile_compile':'PASS_NO_KERNEL_LOAD','invalid_profile':'REJECTED_AS_EXPECTED',
        'actual_cdp_environment_check':'PASS_NO_BROWSER','python_syntax_files':len([p for p in source_files if p.suffix=='.py']),
        'owner_approval_received':False,'security_configuration_applied':False,
        'positive_sandbox_test':'NOT_RUN_REQUIRES_OWNER_APPROVAL','new_chromium_executions':0,
        'SANDBOX_READINESS':'PREPARED_AWAITING_OWNER_APPROVAL','LIVE_SOURCE_ACCESS':'BLOCKED_AUTHORIZATION',
        'accepted':False,'approved_plan_sha256':None,'proposed_plan_sha256':plan['plan_sha256']})
    files={p.name:{'sha256':sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size}
        for p in sorted(OUT.iterdir())if p.is_file()and p.name!='evidence-manifest.json'}
    write('evidence-manifest.json',{'schema':'ote-sandbox-evidence:1','files':files,'self_excluded':True})
    print(json.dumps({'sealed_files':len(files),'review_packet_sha256':sha256(packet).hexdigest(),
        'plan_sha256':plan['plan_sha256'],'SANDBOX_READINESS':'PREPARED_AWAITING_OWNER_APPROVAL'}))


if __name__=='__main__':main()
