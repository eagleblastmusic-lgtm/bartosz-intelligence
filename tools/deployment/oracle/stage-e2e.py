"""Stage current public source for a bounded Oracle-local E2E test.

No production symlink, permanent service, remote D1 write or cookie import.
The staged source reuses the already installed ARM64 dependency tree.
"""
import argparse
import base64
from hashlib import sha256
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
from uuid import uuid4

PROJECT = Path(__file__).resolve().parents[3]
EXISTING_RELEASE = 'ded32ba756908c3820502cb66b45d11f13232d739bc546146eacc7dfea821345'
REMOTE = r'''
import base64,hashlib,io,json,os,pathlib,stat,tarfile
assert os.geteuid() == 0
assert re.fullmatch('[0-9a-f]{8}',RUN_ID)
stage = pathlib.Path('/opt/bartosz-intelligence/staging')/('e2e-'+RUN_ID)
state = pathlib.Path('/var/lib/bartosz-executor')/('e2e-'+RUN_ID)
socket_dir = pathlib.Path('/run')/('bartosz-e2e-'+RUN_ID)
runtime = pathlib.Path('/opt/bartosz-intelligence/browser-runtime/youtube-mweb')

def root_dir(path):
    assert path.resolve() == path
    if path.exists():
        meta = path.lstat()
        assert stat.S_ISDIR(meta.st_mode) and meta.st_uid == 0 and not meta.st_mode & 0o022
    else:
        root_dir(path.parent)
        path.mkdir(mode=0o755)

root_dir(stage.parent)
assert not stage.exists() and not state.exists() and not socket_dir.exists()
stage.mkdir(mode=0o755)
state.mkdir(mode=0o700)
os.chown(state,997,988)
socket_dir.mkdir(mode=0o750)
os.chown(socket_dir,0,988)
archive = base64.b64decode(ARCHIVE,validate=True)
assert hashlib.sha256(archive).hexdigest() == ARCHIVE_SHA
installed = {}
with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as source:
    for member in source.getmembers():
        name = pathlib.PurePosixPath(member.name)
        assert not name.is_absolute() and '..' not in name.parts and member.isfile()
        assert name.name not in {'.env','.dev.vars','executor.env'}
        assert '.local' not in name.parts and '.git' not in name.parts and 'node_modules' not in name.parts
        data = source.extractfile(member).read()
        assert hashlib.sha256(data).hexdigest() == FILES[member.name]
        target = stage/member.name
        target.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
        target.write_bytes(data)
        target.chmod(0o755 if name.suffix == '.sh' else 0o644)
        installed[member.name] = hashlib.sha256(target.read_bytes()).hexdigest()
existing = pathlib.Path('/opt/bartosz-intelligence/releases')/EXISTING_RELEASE
assert existing.resolve() == existing and (existing/'node_modules').is_dir()
assert hashlib.sha256((existing/'release-manifest.json').read_bytes()).hexdigest() == '8cc476e32234159dafd55a3e6f5f5bfe067fef4c41df5ff23891c0fad92ae283'
(stage/'node_modules').symlink_to(existing/'node_modules',target_is_directory=True)
# pnpm workspace package links needed by Wrangler/source imports.
for rel in ['apps/api','apps/executor','packages/core','packages/contracts','packages/telemetry']:
    if (existing/rel/'node_modules').is_dir():
        (stage/rel/'node_modules').symlink_to(existing/rel/'node_modules',target_is_directory=True)
updated = {}
for name in ['tools/transcript-engine/login-diagnostic.py','tools/transcript-engine/login-diagnostic-oracle.py']:
    target = runtime/name
    meta = target.lstat()
    assert stat.S_ISREG(meta.st_mode) and meta.st_uid == 0 and meta.st_nlink == 1 and not meta.st_mode & 0o022
    data = (stage/name).read_bytes()
    compile(data,str(target),'exec')
    temporary = target.with_name(target.name+'.e2e-public-tmp')
    fd = os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
    try:
        os.fchmod(fd,0o644)
        with os.fdopen(fd,'wb',closefd=False) as stream: stream.write(data)
        os.fsync(fd)
    finally: os.close(fd)
    try: os.replace(temporary,target)
    finally:
        if temporary.exists(): temporary.unlink()
    updated[name] = hashlib.sha256(target.read_bytes()).hexdigest()
manifest_path = runtime/'public-install.json'
manifest = json.loads(manifest_path.read_bytes())
for name,digest in updated.items():
    manifest['installed_public_files'][name].update(sha256=digest,bytes=(runtime/name).stat().st_size)
manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
manifest_path.chmod(0o644)
receipt = {'schema':'oracle-local-e2e-stage:1','status':'STAGED_PUBLIC_SOURCE_ONLY',
    'run_id':RUN_ID,'stage':str(stage),'state':str(state),'socket_dir':str(socket_dir),
    'socket':str(socket_dir/'caption.sock'),'port':8789,'archive_sha256':ARCHIVE_SHA,
    'source_files':installed,'runtime_public_updates':updated,'reused_release':str(existing),
    'remote_d1_writes':0,'production_link_changed':False,'permanent_services_changed':False,
    'cookies_read':False,'source_requests':0,'runtime_jobs_started':0}
(stage/'stage-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--key',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args = parser.parse_args()
    tracked = subprocess.check_output(['git','ls-files','-z','--','apps','packages','tools','config','db'],cwd=PROJECT).decode().split('\0')
    names = {name for name in tracked if name and '.local' not in Path(name).parts}
    names.update('tools/transcript-engine/'+name for name in ['login-diagnostic.py',
        'login-diagnostic-oracle.py','pot-transport-trace.mjs','caption-broker.py'])
    names.update(path.relative_to(PROJECT).as_posix() for path in (PROJECT/'tools/deployment/oracle').iterdir()
        if path.is_file())
    names.update(['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.base.json',
        'tsconfig.tools.json','.node-version','tools/executor/run-oracle.ts',
        'apps/executor/src/oracle-runtime.ts','apps/executor/src/providers/oracle-captions.ts'])
    names.add('packages/core/src/transcript/intake.ts')
    names = {name for name in names if Path(name).name not in {'.env','.dev.vars','executor.env'}
        and Path(name).suffix not in {'.key','.pem','.pyc','.zip'}}
    bodies = {}
    for name in sorted(names):
        path = PROJECT/name
        if path.is_symlink() or not path.is_file(): raise ValueError('PUBLIC_STAGE_SOURCE_MISSING')
        bodies[name] = path.read_bytes()
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer,mode='w:gz') as archive:
        for name,data in sorted(bodies.items()):
            item = tarfile.TarInfo(name)
            item.size = len(data)
            item.mode = 0o644
            archive.addfile(item,io.BytesIO(data))
    data = buffer.getvalue()
    files = {name:sha256(body).hexdigest() for name,body in bodies.items()}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    (args.output.parent/'e2e-public-source.tar.gz').write_bytes(data)
    source = '\n'.join(name+'='+repr(value) for name,value in {'RUN_ID':uuid4().hex[:8],
        'ARCHIVE':base64.b64encode(data).decode(),'ARCHIVE_SHA':sha256(data).hexdigest(),
        'FILES':files,'EXISTING_RELEASE':EXISTING_RELEASE}.items())+'\nimport re\n'+REMOTE
    sys.path.insert(0,str(PROJECT/'tools/transcript-engine/sandbox'))
    from diagnose import ssh
    command = ssh(args.key)
    command[-1] = ('env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin sudo -n /usr/bin/env -i '
        'PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 /usr/bin/python3 -I -B -')
    run = subprocess.run(command,input=source.encode(),capture_output=True,timeout=100)
    try: receipt = json.loads(run.stdout)
    except (ValueError,UnicodeError):
        receipt = {'status':'STAGE_FAILED','stderr':run.stderr.decode('utf-8','replace')[-8192:]}
    receipt['ssh_exit_code'] = run.returncode
    args.output.write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({key:receipt.get(key) for key in ['status','run_id','stage','state','socket','port','ssh_exit_code']}))
    return run.returncode


if __name__ == '__main__':
    raise SystemExit(main())
