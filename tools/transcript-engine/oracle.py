"""Transfer the diagnostic bundle to /tmp, run offline, retrieve evidence, remove it.

Portable browser download is temporary, version-pinned and HTTPS-only. No apt,
pip, pnpm, systemd start, production worker, D1 or release modification.
"""
from __future__ import annotations
import argparse
import base64
import gzip
from hashlib import sha256
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
REMOTE = r'''
import base64, gzip, hashlib, io, json, os, pathlib, platform, resource, subprocess, tarfile, tempfile, time, urllib.request, zipfile
blob = base64.b64decode(ARCHIVE)
assert hashlib.sha256(blob).hexdigest() == ARCHIVE_HASH
node = '/opt/bartosz-intelligence/runtime/node-24.21.0/bin/node'
python = '/usr/bin/python3'
env = {'PATH':'/usr/bin:/bin','PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1'}
results = {'schema':'ote-oracle:1','platform':platform.platform(),'machine':platform.machine(),
    'diagnostic_archive_sha256':hashlib.sha256(blob).hexdigest(),'production_d1_calls':0,'release_modified':False,'services_started':0}
with tempfile.TemporaryDirectory(prefix='bartosz-ote-') as temporary:
    root = pathlib.Path(temporary).resolve()
    assert root.parent == pathlib.Path('/tmp')
    with tarfile.open(fileobj=io.BytesIO(blob),mode='r:gz') as tar:
        tar.extractall(root,filter='data')
    out = root / 'evidence'
    out.mkdir()
    def execute(name, command, timeout=90):
        p=subprocess.run(command,cwd=root,env=env,capture_output=True,timeout=timeout)
        if p.returncode:
            results[name]={'execution':'FAIL','exit_code':p.returncode,'stderr_sha256':hashlib.sha256(p.stderr).hexdigest()}
            return False
        results[name]={'execution':'PASS','stdout':json.loads(p.stdout)}
        return True
    supervise = [python,'-B','tools/transcript-engine/supervise.py']
    execute('portable',supervise+['--output',str(out/'portable-resources.json'),'--timeout','30','--',node,'--max-old-space-size=192','tools/transcript-engine/engine-check.mjs','.',str(out/'portable')])
    execute('blocked_live',supervise+['--output',str(out/'blocked-resources.json'),'--timeout','15','--',node,'--max-old-space-size=192','tools/transcript-engine/transcript-engine.mjs','native','aircAruvnKk','tests/fixtures/transcript-engine/native-blocked.json',str(out/'blocked-live')])
    if WITH_BROWSER:
        started=time.monotonic()
        binary_dir='chrome-headless-shell-linux-arm64' if BROWSER_FLAVOR=='shell' else 'chrome-linux-arm64'
        binary_name='chrome-headless-shell' if BROWSER_FLAVOR=='shell' else 'chrome'
        url='https://cdn.playwright.dev/builds/cft/153.0.8010.12/linux-arm64/'+binary_dir+'.zip'
        archive=root/'browser.zip'
        h=hashlib.sha256();size=0
        try:
            with urllib.request.urlopen(url,timeout=20) as response, archive.open('wb') as f:
                assert response.status==200
                while True:
                    data=response.read(1024*1024)
                    if not data:break
                    size+=len(data)
                    if size>256*1024*1024 or time.monotonic()-started>90:raise RuntimeError('BROWSER_DOWNLOAD_LIMIT')
                    h.update(data);f.write(data)
            if EXPECTED_BROWSER_HASH and h.hexdigest()!=EXPECTED_BROWSER_HASH:raise RuntimeError('BROWSER_ARCHIVE_HASH_MISMATCH')
            with zipfile.ZipFile(archive) as z:
                for entry in z.infolist():
                    target=(root/'browser'/entry.filename).resolve()
                    assert target.is_relative_to(root/'browser')
                    assert entry.file_size<=600*1024*1024
                assert sum(e.file_size for e in z.infolist())<900*1024*1024
                z.extractall(root/'browser')
            browser=root/'browser'/binary_dir/binary_name
            for name in [binary_name,'chrome_crashpad_handler','chrome_sandbox','chrome-wrapper']:
                p=browser.parent/name
                if p.exists():p.chmod(0o700)
            missing=subprocess.run(['/usr/bin/ldd',str(browser)],capture_output=True,text=True,timeout=10).stdout
            results['browser_runtime']={'archive_url':url,'archive_sha256':h.hexdigest(),'archive_bytes':size,
                'executable_sha256':hashlib.sha256(browser.read_bytes()).hexdigest(),
                'download_elapsed_ms':round((time.monotonic()-started)*1000),
                'missing_libraries':[line.strip().split('=>')[0].strip() for line in missing.splitlines() if 'not found' in line]}
            probe=subprocess.run(supervise+['--output',str(out/'sandbox-probe-resources.json'),'--timeout','10','--',
                str(browser),'--headless=new','--disable-gpu','--no-first-run',
                '--user-data-dir='+str(root/'sandbox-probe-profile'),'--dump-dom','about:blank'],
                cwd=root,env=env,capture_output=True,timeout=15)
            sandbox=probe.returncode==0
            # Historical controlled startup stderr established NAMESPACE_DENIED;
            # this final receipt records only whether sandboxed startup worked.
            results['sandbox_probe']={'supported':sandbox,'supervisor_exit_code':probe.returncode,
                'reason':'SUPPORTED' if sandbox else 'SANDBOXED_STARTUP_FAILED',
                'stderr_sha256':hashlib.sha256(probe.stderr).hexdigest()}
            command=supervise+['--output',str(out/'browser-resources.json'),'--timeout','90','--',node,'--max-old-space-size=192',
                'tools/transcript-engine/browser-check.mjs','.',str(browser),str(out/'browser')]
            if not sandbox:command.append('--no-sandbox')
            if FIRST_ONLY:command.append('--first')
            execute('browser',command,timeout=100)
        except Exception as e:
            # Exception text may include arbitrary network details. Preserve category/hash only.
            results['browser_runtime_failure']={'type':type(e).__name__,'message_sha256':hashlib.sha256(str(e).encode()).hexdigest()}
    execute('resources',[python,'-B','tools/transcript-engine/resource-check.py','--node',node,'--output',str(out/'resource-controls')],timeout=30)
    artifacts={p.relative_to(out).as_posix():p.read_bytes() for p in out.rglob('*') if p.is_file()}
    packed=io.BytesIO()
    with gzip.GzipFile(fileobj=packed,mode='wb',mtime=0,filename='') as compressed:
        with tarfile.open(fileobj=compressed,mode='w') as tar:
            for name,data in sorted(artifacts.items()):
                item=tarfile.TarInfo(name);item.size=len(data);item.mode=0o600;tar.addfile(item,io.BytesIO(data))
    results['artifacts']={'files':len(artifacts),'sha256':hashlib.sha256(packed.getvalue()).hexdigest(),'base64':base64.b64encode(packed.getvalue()).decode()}
results['temporary_files_removed']=not root.exists()
print(json.dumps(results))
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--key', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--with-browser', action='store_true')
    parser.add_argument('--browser-sha256', default='')
    parser.add_argument('--first', action='store_true')
    parser.add_argument('--browser-flavor', choices=['shell', 'full'], default='shell')
    parser.add_argument('--detached', action='store_true', help='Close launch SSH before the Oracle-only experiment completes')
    args = parser.parse_args()
    names = ['tools/transcript-engine/supervise.py', 'tools/transcript-engine/resource-check.py',
             'tests/fixtures/transcript-engine/native-blocked.json']
    names += [f'tools/firefox-transcript-diagnostic-2026-10-12/evidence/{id}.reference.json'
              for id in ['aircAruvnKk', 'IHZwWFHWa-w', 'LPZh9BOjkQs']]
    names += ['tools/firefox-transcript-v0.4.2/evidence/bartosz-transcript-aircAruvnKk.json']
    bodies = {name: (ROOT / name).read_bytes() for name in names}
    for name in ['transcript-engine.mjs', 'engine-check.mjs', 'browser-check.mjs', 'dom-reader.js']:
        bodies['tools/transcript-engine/' + name] = (ROOT / '.local/transcript-engine' / name).read_bytes()
    stream = io.BytesIO()
    with gzip.GzipFile(fileobj=stream, mode='wb', mtime=0, filename='') as compressed:
        with tarfile.open(fileobj=compressed, mode='w') as tar:
            for name, body in sorted(bodies.items()):
                entry = tarfile.TarInfo(name)
                entry.size = len(body)
                entry.mode = 0o600
                tar.addfile(entry, io.BytesIO(body))
    archive = stream.getvalue()
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / 'diagnostic.tar.gz').write_bytes(archive)
    variables = {'ARCHIVE': base64.b64encode(archive).decode(), 'ARCHIVE_HASH': sha256(archive).hexdigest(),
                 'WITH_BROWSER': args.with_browser, 'EXPECTED_BROWSER_HASH': args.browser_sha256, 'FIRST_ONLY': args.first,
                 'BROWSER_FLAVOR': args.browser_flavor}
    remote = '\n'.join(f'{name} = {value!r}' for name, value in variables.items()) + '\n' + REMOTE
    ssh_exe = 'C:/Windows/System32/OpenSSH/ssh.exe' if __import__('os').name == 'nt' else shutil.which('ssh')
    ssh = [ssh_exe, '-F', 'NUL' if __import__('os').name == 'nt' else '/dev/null', '-i', str(args.key.resolve()),
           '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'StrictHostKeyChecking=yes',
           '-o', 'ConnectTimeout=15', 'ubuntu@89.168.89.196', 'env -i PATH=/usr/bin:/bin /usr/bin/python3 -B -']
    detached_receipt = None
    if args.detached:
        launch = '''
import json, pathlib, subprocess, tempfile, time
directory=pathlib.Path(tempfile.mkdtemp(prefix='bartosz-ote-detached-')).resolve()
assert directory.parent==pathlib.Path('/tmp')
(directory/'payload.py').write_text(%r,encoding='utf-8')
driver="import pathlib,runpy,sys\\ntry:\\n runpy.run_path("+repr(str(directory/'payload.py'))+",run_name='__main__')\\nfinally:\\n sys.stdout.flush();sys.stderr.flush();pathlib.Path("+repr(str(directory/'done'))+").write_text('done')\\n"
(directory/'driver.py').write_text(driver,encoding='utf-8')
with (directory/'stdout.json').open('wb') as stdout, (directory/'stderr.bin').open('wb') as stderr:
    child=subprocess.Popen(['/usr/bin/python3','-B',str(directory/'driver.py')],cwd=directory,
        env={'PATH':'/usr/bin:/bin','PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1'},
        stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr,start_new_session=True)
print(json.dumps({'directory':str(directory),'pid':child.pid,'launched_ns':time.time_ns()}))
''' % remote
        launched = subprocess.run(ssh, input=launch.encode(), capture_output=True, timeout=30)
        if launched.returncode:
            raise SystemExit('DETACHED_LAUNCH_FAILED')
        location = json.loads(launched.stdout)
        detached_receipt = {'launch_ssh_exited_before_result_retrieval': True, 'launch_ssh_exit_code': launched.returncode,
            'execution_requires_open_windows_connection': False}
        retrieve = '''
import hashlib,json,pathlib,shutil,time
directory=pathlib.Path(%r).resolve()
assert directory.parent==pathlib.Path('/tmp') and directory.name.startswith('bartosz-ote-detached-') and not directory.is_symlink()
deadline=time.monotonic()+130
while not (directory/'done').is_file() and time.monotonic()<deadline:time.sleep(0.1)
assert (directory/'done').is_file(),'DETACHED_EXPERIMENT_DID_NOT_FINISH'
data=(directory/'stdout.json').read_bytes()
try:result=json.loads(data)
except Exception:result={'detached_failure':True,'stderr_sha256':hashlib.sha256((directory/'stderr.bin').read_bytes()).hexdigest()}
shutil.rmtree(directory)
result['detached_state_removed']=not directory.exists()
print(json.dumps(result))
''' % location['directory']
        run = subprocess.run(ssh, input=retrieve.encode(), capture_output=True, timeout=150)
    else:
        run = subprocess.run(ssh, input=remote.encode(), capture_output=True, timeout=240)
    if run.returncode:
        (args.output / 'ssh-failure.json').write_text(json.dumps({'exit_code': run.returncode,
            'stderr_sha256': sha256(run.stderr).hexdigest()}) + '\n', encoding='utf-8')
        raise SystemExit('ORACLE_DIAGNOSTIC_FAILED_NO_RAW_STDERR_RETAINED')
    result = json.loads(run.stdout)
    if detached_receipt is not None:
        result['detached_execution'] = detached_receipt
    artifacts = result.pop('artifacts')
    packed = base64.b64decode(artifacts.pop('base64'))
    assert sha256(packed).hexdigest() == artifacts['sha256']
    with tarfile.open(fileobj=io.BytesIO(packed), mode='r:gz') as tar:
        tar.extractall(args.output / 'evidence', filter='data')
    result['artifacts'] = artifacts
    result['input_hashes'] = {name: sha256(data).hexdigest() for name, data in sorted(bodies.items())}
    (args.output / 'oracle.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: result[key] for key in result if key not in {'input_hashes'}}))
    return 0 if all(result.get(k, {}).get('execution') == 'PASS' for k in ['portable', 'blocked_live'] + (['browser'] if args.with_browser else [])) else 2


if __name__ == '__main__':
    raise SystemExit(main())
