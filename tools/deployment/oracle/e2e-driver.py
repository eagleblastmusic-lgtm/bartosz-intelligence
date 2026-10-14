"""Autonomous bounded Oracle-local API -> executor -> caption -> D1 -> API test."""
import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request
import urllib.error

NODE = '/opt/bartosz-intelligence/runtime/node-24.21.0/bin/node'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--socket', type=Path, required=True)
    args = parser.parse_args()
    assert os.geteuid() == 0
    assert args.stage.resolve() == args.stage and re.fullmatch('e2e-[0-9a-f]{8}', args.stage.name)
    assert args.stage.parent == Path('/opt/bartosz-intelligence/staging')
    assert args.state == Path('/var/lib/bartosz-executor')/args.stage.name
    suffix = args.stage.name.removeprefix('e2e-')
    assert args.socket == Path('/run')/('bartosz-e2e-'+suffix)/'caption.sock'
    result = {'schema': 'oracle-local-e2e-driver:1', 'status': 'RUNNING',
        'driver_host': 'ORACLE_ARM64', 'backend': 'EXISTING_WORKER_LOCAL_D1_EMULATOR',
        'windows_required_during_jobs': False, 'production_mutations': 0,
        'session_imports': 0, 'commands': [], 'cases': []}
    units = []
    private = args.state/'auth.json'
    config = args.stage/'tools/deployment/oracle/e2e-wrangler.jsonc'
    api = args.stage/'tools/deployment/oracle/e2e-api.ts'
    broker = args.stage/'tools/transcript-engine/caption-broker.py'
    environment = {'PATH': str(Path(NODE).parent)+':/usr/bin:/bin',
        'HOME': str(args.state), 'TMPDIR': str(args.state), 'LANG': 'C.UTF-8',
        'CI': 'true', 'WRANGLER_SEND_METRICS': 'false', 'XDG_CONFIG_HOME': str(args.state/'config'),
        'MINIFLARE_CACHE_DIR': str(args.state/'miniflare-cache'), 'CLOUDFLARE_CF_FETCH_ENABLED': 'false'}

    def save():
        (args.state/'e2e-result.json').write_text(json.dumps(result, indent=2)+'\n')
        (args.state/'e2e-result.json').chmod(0o600)

    def command(argv, timeout=60, actor=997, retain_output=False):
        started = time.monotonic()
        run = subprocess.run(argv, cwd=args.stage, env=environment, capture_output=True,
            timeout=timeout, user=actor, group=988 if actor == 997 else 0, extra_groups=[])
        record = {'program': Path(argv[0]).name, 'exit_code': run.returncode,
            'elapsed_ms': round((time.monotonic()-started)*1000),
            'stdout_bytes': len(run.stdout), 'stderr_bytes': len(run.stderr),
            'stdout_sha256': sha256(run.stdout).hexdigest(), 'stderr_sha256': sha256(run.stderr).hexdigest()}
        if run.returncode:
            safe_error = re.search(r'Error: ([A-Z][A-Z0-9_]{1,127})', run.stderr.decode('utf-8','replace'))
            record['failure_code'] = safe_error.group(1) if safe_error else 'E2E_SUBPROCESS_FAILED'
        if retain_output or (run.returncode and argv[0] == '/usr/bin/systemd-run'):
            record['stdout'] = run.stdout.decode('utf-8', 'replace')[-8192:]
            record['stderr'] = run.stderr.decode('utf-8', 'replace')[-8192:]
        result['commands'].append(record)
        save()
        if run.returncode: raise RuntimeError('E2E_COMMAND_FAILED')
        return run.stdout

    def unit(name, argv, actor, memory=384, envfile=None):
        name = 'bartosz-e2e-'+name+'-'+suffix+'.service'
        flags = ['/usr/bin/systemd-run', '--unit='+name,
            '--property=WorkingDirectory='+str(args.stage), '--property=UMask=0077',
            '--property=MemoryMax='+str(memory)+'M', '--property=MemorySwapMax=0',
            '--property=CPUQuota=50%', '--property=TasksMax=128',
            '--property=RuntimeMaxSec=900s', '--property=TimeoutStopSec=15s',
            '--property=KillMode=control-group', '--property=Restart=no',
            '--property=User='+actor, '--property=Group='+('bartosz-executor' if actor == 'bartosz-executor' else 'root')]
        if envfile: flags += ['--property=EnvironmentFile='+str(envfile)]
        flags += ['/usr/bin/env', *[key+'='+value for key,value in environment.items()], *argv]
        command(flags, actor=0)
        units.append(name)
        return name

    def stop(name):
        run = subprocess.run(['/usr/bin/systemctl', 'stop', name], capture_output=True, timeout=20)
        result.setdefault('stopped_units', []).append({'unit': name, 'exit_code': run.returncode})

    def api_phase(phase, output, extra=()):
        command([NODE, '--max-old-space-size=192', '--import', 'tsx', str(api), phase,
            '--private', str(private), '--output', str(output), *extra], timeout=120)

    def await_job(intake, timeout=180, expected='SUCCEEDED'):
        auth = json.loads(private.read_bytes())
        deadline = time.monotonic()+timeout
        while time.monotonic() < deadline:
            request = urllib.request.Request('http://127.0.0.1:8789/api/v1/jobs/'+intake['job_id'],
                headers={'Cookie': auth['owner_cookie'], 'Origin': application_origin})
            with urllib.request.urlopen(request, timeout=10) as response: job = json.loads(response.read())
            result['last_job_state'] = job.get('state')
            save()
            if job.get('state') == expected: return job
            if job.get('state') in {'FAILED', 'CANCELLED', 'BLOCKED', 'RETRY_WAIT', 'DEFERRED'}:
                result['job_failure'] = {key:job.get(key) for key in ['state','reason_code','failure_code']}
                raise RuntimeError('E2E_JOB_TERMINAL_FAILURE')
            time.sleep(1)
        raise RuntimeError('E2E_JOB_DEADLINE')

    api_vars = config.parent/'.dev.vars'
    worker_env = args.state/'worker.env'
    application_origin = json.loads((args.stage/'config/application.json').read_bytes())['app_origin']
    try:
        # The initial dispatch SSH is closed before the job intake phases begin.
        time.sleep(10)
        result['detached_driver_cgroup'] = Path('/proc/self/cgroup').read_text().strip()
        # Wrangler's build output belongs in the isolated writable state, not
        # the root-owned source/dependency release.
        build_state = args.state/'wrangler-build'
        build_state.mkdir(mode=0o700, exist_ok=True)
        os.chown(build_state,997,988)
        build_link = config.parent/'.wrangler'
        if not build_link.exists(): build_link.symlink_to(build_state, target_is_directory=True)
        assert build_link.is_symlink() and build_link.resolve() == build_state
        command([NODE, '--max-old-space-size=192', str(args.stage/'node_modules/wrangler/bin/wrangler.js'),
            'd1', 'migrations', 'apply', 'oracle-local-e2e', '--local', '--persist-to', str(args.state/'d1'),
            '--config', str(config)], timeout=120, retain_output=True)
        api_phase('seed', args.state/'seed-proof.json', ['--config', str(config), '--state', str(args.state/'d1')])
        auth = json.loads(private.read_bytes())
        values = {'APP_ORIGIN': application_origin, 'GOOGLE_OIDC_CLIENT_ID': 'isolated-e2e-client',
            'GOOGLE_OIDC_CLIENT_SECRET': 'isolated-e2e-client-secret',
            'GOOGLE_OIDC_OWNER_SUBJECT': auth['owner_subject'],
            'SESSION_SIGNING_SECRET': auth['session_signing_secret']}
        api_vars.write_text('\n'.join(key+'='+json.dumps(value) for key,value in values.items())+'\n')
        os.chown(api_vars,997,988)
        api_vars.chmod(0o600)
        worker_values = {'APP_ORIGIN': 'http://127.0.0.1:8789',
            'LOCAL_WORKER_CREDENTIAL': auth['worker_credential'], 'BARTOSZ_WORKER_ID': auth['worker_id'],
            'BARTOSZ_CONCURRENCY': '1', 'BARTOSZ_NONPRODUCTION': 'true',
            'BARTOSZ_SOURCE_QUALIFIED': 'true', 'BARTOSZ_CAPTION_SOCKET': str(args.socket),
            'BARTOSZ_PYTHON': '/opt/bartosz-intelligence/runtime/python/bin/python',
            'BARTOSZ_DENO': '/opt/bartosz-intelligence/runtime/deno-2.9.7/deno',
            'BARTOSZ_FFMPEG': '/usr/bin/ffmpeg', 'BARTOSZ_STATE_DIRECTORY': str(args.state)}
        worker_env.write_text('\n'.join(key+'='+value for key,value in worker_values.items())+'\n')
        worker_env.chmod(0o600)
        del auth
        broker_unit = unit('broker', ['/usr/bin/python3','-I','-B',str(broker),'--socket',str(args.socket)], 'root', 192)
        api_unit = unit('api', [NODE,'--max-old-space-size=192',str(args.stage/'node_modules/wrangler/bin/wrangler.js'),
            'dev','--local','--config',str(config),'--persist-to',str(args.state/'d1'),
            '--ip','127.0.0.1','--port','8789'], 'bartosz-executor', 768)
        ready = time.monotonic()+40
        while time.monotonic() < ready:
            try:
                try: response = urllib.request.urlopen('http://127.0.0.1:8789/health',timeout=2)
                except urllib.error.HTTPError as error: response = error
                with response:
                    health = json.loads(response.read())
                    # This API-only harness intentionally has no UI assets.
                    if health.get('bindings',{}).get('DB') and health.get('bindings',{}).get('BARTOSZ_QUEUE') and args.socket.is_socket():
                        result['api_health_bindings'] = health['bindings']
                        break
            except OSError: pass
            time.sleep(0.5)
        else: raise RuntimeError('E2E_API_OR_BROKER_NOT_READY')
        worker_unit = None
        for index, video in enumerate(['aircAruvnKk','uEztHu4NHrs']):
            if worker_unit:
                stop(worker_unit)
                result['worker_restarted_between_creators'] = True
            worker_unit = unit('worker-'+str(index+1), [NODE,'--max-old-space-size=192','--import','tsx',
                str(args.stage/'tools/executor/run-oracle.ts')], 'bartosz-executor', envfile=worker_env)
            intake_path = args.state/('intake-'+str(index+1)+'.json')
            api_phase('intake', intake_path, ['--base','http://127.0.0.1:8789','--video',video])
            intake = json.loads(intake_path.read_bytes())
            await_job(intake)
            proof_path = args.state/('read-proof-'+str(index+1)+'.json')
            api_phase('verify', proof_path, ['--base','http://127.0.0.1:8789','--input',str(intake_path)])
            result['cases'].append(json.loads(proof_path.read_bytes()))
            save()
        stop(worker_unit)
        fixture = args.state/'auth-failure-fixture.py'
        failure_socket = args.state/'auth-failure.sock'
        fixture.write_text('''import json,socket,sys,os
path=sys.argv[1]
server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
server.bind(path)
os.chmod(path,0o600)
server.listen(1)
try:
 with server.accept()[0] as client:
  body=b''
  while b'\\n' not in body:
   body+=client.recv(8192)
  value=json.loads(body)
  assert value['operation']=='list' and value['video_id']=='zzzzzzzzzzz'
  client.sendall((json.dumps({'status':'AUTH_REQUIRED','failure_code':'AUTH_REAUTH_REQUIRED','tracks':[],'video_language':None})+'\\n').encode())
finally:
 server.close()
 os.unlink(path)
''')
        os.chown(fixture,997,988)
        fixture.chmod(0o600)
        unit('auth-fixture',['/usr/bin/python3','-I','-B',str(fixture),str(failure_socket)],'bartosz-executor',64)
        ready=time.monotonic()+5
        while not failure_socket.is_socket() and time.monotonic()<ready: time.sleep(0.05)
        if not failure_socket.is_socket(): raise RuntimeError('E2E_FAILURE_FIXTURE_NOT_READY')
        worker_values['BARTOSZ_CAPTION_SOCKET']=str(failure_socket)
        worker_env.write_text('\n'.join(key+'='+value for key,value in worker_values.items())+'\n')
        worker_env.chmod(0o600)
        unit('worker-auth-failure',[NODE,'--max-old-space-size=192','--import','tsx',
            str(args.stage/'tools/executor/run-oracle.ts')],'bartosz-executor',envfile=worker_env)
        failure_intake=args.state/'intake-auth-failure.json'
        api_phase('intake',failure_intake,['--base','http://127.0.0.1:8789','--video','zzzzzzzzzzz'])
        job=await_job(json.loads(failure_intake.read_bytes()),timeout=60,expected='BLOCKED')
        if job.get('reason_code')!='LOCAL_YTDLP_AUTH_REQUIRED' or job.get('attempt_count')!=1:
            raise RuntimeError('E2E_AUTH_FAILURE_CLASSIFICATION')
        result['controlled_failure']={'status':'PASS','simulated':True,'job_state':job['state'],
            'reason_code':job['reason_code'],'attempt_count':job['attempt_count'],
            'actual_youtube_requests':0,'canonical_session_touched':False}
        fixture.unlink()
        result['status'] = 'PASS_ORACLE_LOCAL_API_EXECUTOR_D1_ARTIFACT_READ'
    except Exception as error:
        result['status'] = 'E2E_FAILED'
        result['failure_code'] = str(error) if isinstance(error,RuntimeError) else type(error).__name__
    finally:
        for name in reversed(units): stop(name)
        for path in [api_vars, worker_env, private]:
            if path.exists(): path.unlink()
        result['private_fixture_credentials_removed'] = all(not path.exists() for path in [api_vars, worker_env, private])
        result['broker_socket_removed'] = not args.socket.exists()
        result['completed_at_unix'] = time.time()
        save()


if __name__ == '__main__':
    main()
