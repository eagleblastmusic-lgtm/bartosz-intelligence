"""Install the public Oracle-local mweb command; never import or read cookies."""
import argparse
import base64
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
PUBLIC_FILES = [
    'tools/transcript-engine/login-diagnostic.py',
    'tools/transcript-engine/login-diagnostic-oracle.py',
    'tools/transcript-engine/pot-transport-trace.mjs',
    'apps/executor/python/transcript_ytdlp.py',
    'tools/gates/adapters/gate0_python_adapters.py',
]
LAUNCHER = '''#!/bin/bash
set -eu
if [ "$#" -ne 1 ] || [[ ! "$1" =~ ^[A-Za-z0-9_-]{11}$ ]]; then
  printf '%s\\n' 'Usage: transcribe VIDEO_ID' >&2
  exit 2
fi
exec /usr/bin/python3 -I -B /opt/bartosz-intelligence/browser-runtime/youtube-mweb/tools/transcript-engine/login-diagnostic-oracle.py \\
  --on-oracle \\
  --script /opt/bartosz-intelligence/browser-runtime/youtube-mweb/tools/transcript-engine/login-diagnostic.py \\
  --label persistent-local --mode ytdlp --client mweb --persistent-session \\
  --pot-server /opt/bartosz-intelligence/browser-runtime/youtube-mweb/provider/server \\
  --video "$1"
'''
REMOTE = r'''
import base64, hashlib, json, os, pathlib, shutil, stat, subprocess, sys
runtime = pathlib.Path('/opt/bartosz-intelligence/browser-runtime')
target = runtime/'youtube-mweb'
source = pathlib.Path('/home/bartosz-browser-runtime/snap/chromium/common/jobs/login-bgutils-prep-deb0fe2b/provider/server')
assert os.geteuid() == 0 and sys.flags.isolated

def root_directory(path):
    assert path.is_absolute() and path.resolve() == path
    if path.exists():
        meta = path.lstat()
        assert stat.S_ISDIR(meta.st_mode) and meta.st_uid == 0 and not meta.st_mode & 0o022
    else:
        root_directory(path.parent)
        path.mkdir(mode=0o755)
    return path

for path in [*reversed(runtime.parents), runtime]:
    meta = path.lstat()
    assert not stat.S_ISLNK(meta.st_mode) and meta.st_uid == 0 and not meta.st_mode & 0o022
active = []
for entry in pathlib.Path('/proc').iterdir():
    if not entry.name.isdigit(): continue
    try:
        fields = (entry/'status').read_text().splitlines()
        uid = next(line for line in fields if line.startswith('Uid:')).split()[1]
        if uid == '30000': active.append(int(entry.name))
    except (OSError, StopIteration): pass
assert not active, 'BROWSER_UID_MUST_BE_IDLE'
assert source.resolve() == source
fixed_hashes = {
    'package.json':'325cf8e4c7bce37870ecb3275df3c67f9d2058ecb0d7e728c99278207873c169',
    'package-lock.json':'a165d8008e3830af7b8f251b9cc74500eb8299d68456d689281234b572d52fb0',
    'build/generate_once.js':'d8a2ee807465547379f25ec9b24da973b026b2cf4518841167b1e4b401c19bdf',
    'node_modules/canvas/build/Release/canvas.node':'cc580bb1183d0a0af2d56ca23d265cad127def476e9d5950e1835131eafa5371',
}
for name, expected in fixed_hashes.items():
    path = source/name
    assert path.is_file() and not path.is_symlink()
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected
root_directory(target)

def write_public(relative, data, expected, mode=0o644):
    assert hashlib.sha256(data).hexdigest() == expected
    relative_path = pathlib.PurePosixPath(relative)
    assert not relative_path.is_absolute() and '..' not in relative_path.parts
    path = target/relative
    root_directory(path.parent)
    assert path.resolve() == path
    if path.exists():
        meta = path.lstat()
        assert stat.S_ISREG(meta.st_mode) and meta.st_uid == 0 and meta.st_nlink == 1
    temporary = path.with_name(path.name+'.public-install-tmp')
    fd = os.open(temporary, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, mode)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd,'wb',closefd=False) as stream: stream.write(data)
        os.fsync(fd)
    finally: os.close(fd)
    os.replace(temporary,path)
    return {'path':str(path),'sha256':expected,'bytes':len(data),'mode':oct(mode),'uid':0,'gid':0}

installed = {}
for name, entry in FILES.items():
    data = base64.b64decode(entry['base64'],validate=True)
    if name.endswith('.py'): compile(data,str(target/name),'exec')
    installed[name] = write_public(name,data,entry['sha256'])
launcher = base64.b64decode(LAUNCHER,validate=True)
installed['transcribe'] = write_public('transcribe',launcher,LAUNCHER_HASH,0o755)

selected = [source/'package.json',source/'package-lock.json',source/'build/generate_once.js']
for directory, subdirs, files in os.walk(source/'node_modules',followlinks=False):
    for name in [*subdirs,*files]:
        path = pathlib.Path(directory)/name
        meta = path.lstat()
        assert stat.S_ISREG(meta.st_mode) or stat.S_ISDIR(meta.st_mode) or stat.S_ISLNK(meta.st_mode)
        if path.is_symlink():
            assert os.path.commonpath([source,path.resolve()]) == str(source)
            assert not os.path.isabs(os.readlink(path))
        if not path.is_dir() or path.is_symlink(): selected.append(path)
provider = target/'provider/server'
provider_created = not provider.exists()
root_directory(provider)
tree = []
for path in sorted(selected):
    rel = path.relative_to(source)
    destination = provider/rel
    root_directory(destination.parent)
    if path.is_symlink():
        link = os.readlink(path)
        if destination.is_symlink(): assert os.readlink(destination) == link
        else:
            assert not destination.exists()
            destination.symlink_to(link)
            os.lchown(destination,0,0)
        tree.append({'path':str(rel),'link':link})
        continue
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    mode = 0o755 if path.stat().st_mode & 0o111 else 0o644
    if destination.exists():
        meta = destination.lstat()
        assert stat.S_ISREG(meta.st_mode) and meta.st_uid == 0 and meta.st_nlink == 1
        assert hashlib.sha256(destination.read_bytes()).hexdigest() == digest
        assert stat.S_IMODE(meta.st_mode) == mode
    else:
        fd = os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
        try:
            os.fchmod(fd,mode)
            with os.fdopen(fd,'wb',closefd=False) as stream: stream.write(data)
        finally: os.close(fd)
    tree.append({'path':str(rel),'sha256':digest,'bytes':len(data),'mode':oct(mode)})
tree_hash = hashlib.sha256(json.dumps(tree,sort_keys=True,separators=(',',':')).encode()).hexdigest()
proofs = []
for argv in [['/bin/bash','-n',str(target/'transcribe')],
             ['/usr/bin/python3','-I','-B',str(target/'tools/transcript-engine/login-diagnostic-oracle.py'),'--help']]:
    run = subprocess.run(argv,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},capture_output=True,timeout=10)
    assert run.returncode == 0
    proofs.append({'argv':argv,'exit_code':run.returncode,
        'stdout_sha256':hashlib.sha256(run.stdout).hexdigest(),'stderr_bytes':len(run.stderr)})
receipt = {'schema':'ote-persistent-public-runtime:1','status':'PASS_PUBLIC_RUNTIME_INSTALL_ONLY',
    'runtime_root':str(target),'launcher':str(target/'transcribe'),'provider_server':str(provider),
    'provider_created':provider_created,'provider_stock_hashes':fixed_hashes,
    'provider_tree_sha256':tree_hash,'provider_file_count':len(tree),
    'provider_file_bytes':sum(row.get('bytes',0) for row in tree),
    'installed_public_files':installed,'proofs':proofs,
    'source_requests':0,'cookies_read':False,'session_directory_touched':False,
    'token_generation_attempts':0,'provider_version_and_import_proof':'oracle-bgutils-prep-verify.json',
    'browser_uid_idle_before_install':True,'permanent_services_changed':False,'global_dependencies_installed':False}
(target/'public-install.json').write_text(json.dumps(receipt,indent=2)+'\n')
(target/'public-install.json').chmod(0o644)
print(json.dumps(receipt))
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--key',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args = parser.parse_args()
    files = {}
    for name in PUBLIC_FILES:
        data = (PROJECT/name).read_bytes()
        files[name] = {'sha256':sha256(data).hexdigest(),'base64':base64.b64encode(data).decode()}
    launcher = LAUNCHER.encode()
    source = '\n'.join(name+'='+repr(value) for name,value in {
        'FILES':files,'LAUNCHER':base64.b64encode(launcher).decode(),
        'LAUNCHER_HASH':sha256(launcher).hexdigest()}.items())+'\n'+REMOTE
    sys.path.insert(0,str(HERE/'sandbox'))
    from diagnose import ssh
    command = ssh(args.key)
    command[-1] = ('env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin sudo -n /usr/bin/env -i '
        'PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 /usr/bin/python3 -I -B -')
    run = subprocess.run(command,input=source.encode(),capture_output=True,timeout=100)
    try:
        receipt = json.loads(run.stdout)
    except (ValueError,UnicodeError):
        receipt = {'schema':'ote-persistent-public-runtime:1','status':'INSTALL_FAILED',
            'stderr':run.stderr.decode('utf-8','replace')[-8192:]}
    receipt['ssh_exit_code'] = run.returncode
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({key:receipt.get(key) for key in ['status','runtime_root','launcher',
        'provider_tree_sha256','provider_file_count','source_requests','cookies_read','ssh_exit_code']}))
    return run.returncode


if __name__ == '__main__':
    raise SystemExit(main())
