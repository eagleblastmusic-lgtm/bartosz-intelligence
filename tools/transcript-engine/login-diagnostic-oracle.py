"""Run one diagnostic in the retained Oracle browser boundary; no deployment.

The diagnostic receives MODE OUTPUT --video ID [--client CLIENT]. It writes
result.json and optional .json/.txt/.raw artifacts into OUTPUT.
"""
import argparse
import base64
from hashlib import sha256
from http.cookiejar import HTTPONLY_ATTR, LoadError, MozillaCookieJar
import io
import inspect
import json
from pathlib import Path
import re
import subprocess
import sys
from uuid import uuid4
import warnings

HERE = Path(__file__).resolve().parent


def validate_cookie_export(body):
    """Parse a bounded export without retaining comments or unrelated domains."""
    if not body or len(body) > 64*1024:
        raise ValueError('COOKIE_EXPORT_SIZE_INVALID')
    jar = MozillaCookieJar()
    try:
        # cookiejar warnings can embed a malformed input value in a traceback.
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            jar._really_load(io.StringIO(body.decode('utf-8-sig')), 'YouTube-cookie-export', True, True)
    except (LoadError, ValueError, UnicodeError, OSError):
        raise ValueError('COOKIE_EXPORT_INVALID') from None
    cookies = list(jar)
    if not cookies or any(cookie.domain not in {'.youtube.com', 'youtube.com'} for cookie in cookies):
        raise ValueError('COOKIE_EXPORT_YOUTUBE_ONLY_REQUIRED')
    signed_in = {'SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID',
                 '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID'}
    if not any(cookie.name in signed_in and cookie.value for cookie in cookies):
        raise ValueError('COOKIE_EXPORT_SIGNED_IN_COOKIE_REQUIRED')
    lines = ['# Netscape HTTP Cookie File']
    for cookie in cookies:
        domain = cookie.domain
        if cookie.has_nonstandard_attr(HTTPONLY_ATTR):
            domain = '#HttpOnly_'+domain
        fields = [domain, 'TRUE' if cookie.domain.startswith('.') else 'FALSE',
                  cookie.path or '/', 'TRUE' if cookie.secure else 'FALSE',
                  '' if cookie.expires is None else str(cookie.expires), cookie.name, cookie.value or '']
        if any(any(char in field for char in '\t\r\n') for field in fields):
            raise ValueError('COOKIE_EXPORT_INVALID')
        lines.append('\t'.join(fields))
    canonical = ('\n'.join(lines)+'\n').encode()
    if len(canonical) > 64*1024:
        raise ValueError('COOKIE_EXPORT_SIZE_INVALID')
    return canonical, {
        'cookie_count': len(cookies), 'signed_in_cookie_present': True,
    }


REMOTE = r'''
import base64, fcntl, hashlib, http.cookiejar, importlib.util, io, json, os, pathlib, re, shutil, stat, sys, time, warnings
from http.cookiejar import HTTPONLY_ATTR, LoadError, MozillaCookieJar
root = pathlib.Path('/root/bartosz-ote-chromium-deployment-20261014')
runtime = pathlib.Path('/opt/bartosz-intelligence/browser-runtime')
home = pathlib.Path('/home/bartosz-browser-runtime')
assert os.geteuid() == 0 and sys.flags.isolated
for path in [*reversed(root.parents), root, root/'snap-trial.py', runtime]:
    meta = path.lstat()
    assert not stat.S_ISLNK(meta.st_mode) and meta.st_uid == 0 and not meta.st_mode & 0o022
spec = importlib.util.spec_from_file_location('retained_snap_trial', root/'snap-trial.py')
trial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trial)
trial.ROOT, trial.TRIAL, trial.HOME = root, runtime, home
trial.CGROUP_TRIAL = trial.DEPLOYMENT = True
cfg = trial.load('setup.json')
trial.require(cfg['uid'] == cfg['gid'] == 30000 and cfg['slice'] == 'user-30000.slice'
    and cfg['trial'] == str(runtime) and cfg['home'] == str(home), 'RETAINED_BOUNDARY_REQUIRED')
job = home/'snap/chromium/common/jobs'
trial.require(job.resolve() == job and job.stat().st_uid == cfg['uid'], 'RETAINED_JOB_DIRECTORY_REQUIRED')
lock_fd = os.open(runtime/'youtube-job.lock', os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW, 0o600)
fcntl.flock(lock_fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
SESSION_ACTIVE = bool(COOKIES) or PERSISTENT_SESSION
auth_dir = home/'youtube-session'
auth_file = auth_dir/'youtube.cookies'
def secure_file(path):
    meta = path.lstat()
    trial.require(stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1 and meta.st_uid == cfg['uid']
        and meta.st_gid == cfg['gid'] and stat.S_IMODE(meta.st_mode) == 0o600, 'UNSAFE_SESSION_FILE')
    trial.require(path.resolve() == path, 'UNSAFE_SESSION_PATH')

def atomic_session(data):
    temporary = auth_dir/'youtube.cookies.new'
    fd = os.open(temporary, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    try:
        try:
            os.fchown(fd,cfg['uid'],cfg['gid'])
            with os.fdopen(fd,'wb',closefd=False) as stream:
                stream.write(data)
                stream.flush()
                os.fsync(fd)
        finally: os.close(fd)
        os.replace(temporary,auth_file)
    finally:
        if temporary.exists():
            secure_file(temporary)
            temporary.unlink()

if PERSISTENT_SESSION:
    if not auth_dir.exists():
        auth_dir.mkdir(mode=0o700)
        os.chown(auth_dir,cfg['uid'],cfg['gid'])
    meta = auth_dir.lstat()
    trial.require(auth_dir.resolve() == auth_dir and stat.S_ISDIR(meta.st_mode)
        and meta.st_uid == cfg['uid'] and stat.S_IMODE(meta.st_mode) == 0o700, 'UNSAFE_SESSION_DIRECTORY')
    # A killed controller may leave its atomic replacement before rename.
    # The exclusive job lock prevents another controller from writing it now.
    abandoned = auth_dir/'youtube.cookies.new'
    if abandoned.exists():
        meta = abandoned.lstat()
        trial.require(abandoned.resolve() == abandoned and stat.S_ISREG(meta.st_mode)
            and meta.st_nlink == 1 and meta.st_uid in {0,cfg['uid']}
            and stat.S_IMODE(meta.st_mode) == 0o600, 'UNSAFE_PENDING_SESSION_FILE')
        abandoned.unlink()
    if COOKIES:
        trial.require(not auth_file.exists() or REPLACE_SESSION, 'SESSION_ALREADY_INITIALIZED_NO_REIMPORT')
        if auth_file.exists(): secure_file(auth_file)
        canonical,_ = validate_cookie_export(base64.b64decode(COOKIES,validate=True))
        atomic_session(canonical)
        del canonical
    trial.require(auth_file.exists(), 'PERSISTENT_SESSION_MISSING_REAUTH_REQUIRED')
    secure_file(auth_file)
evidence = root/RUN_NAME
evidence.mkdir(mode=0o700)
(evidence/'setup.json').write_text(json.dumps(cfg)+'\n')
(evidence/'setup.json').chmod(0o600)
# stop_test writes its receipt here, preserving the previous deployment evidence.
trial.ROOT = evidence
trial.require(re.fullmatch(r'login-[a-z0-9][a-z0-9-]{0,48}-[0-9a-f]{8}', RUN_NAME), 'INVALID_RUN_NAME')

def remove_cookie(path):
    trial.require(path.parent == runtime and re.fullmatch(
        r'login-[a-z0-9][a-z0-9-]{0,48}-[0-9a-f]{8}\.cookies', path.name), 'UNSAFE_COOKIE_CLEANUP_NAME')
    try: meta = path.lstat()
    except FileNotFoundError: return
    trial.require(stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1
        and meta.st_uid in {0,cfg['uid']} and meta.st_gid in {0,cfg['gid']}
        and stat.S_IMODE(meta.st_mode) == 0o600, 'UNSAFE_COOKIE_CLEANUP_FILE')
    path.unlink()


def remove_browser_state(run_output):
    trial.require(run_output.parent == job and re.fullmatch(
        r'login-[a-z0-9][a-z0-9-]{0,48}-[0-9a-f]{8}', run_output.name), 'UNSAFE_BROWSER_CLEANUP_PARENT')
    for name in ['browser-tmp','pot-private']:
        profile_parent = run_output/name
        if not profile_parent.exists(): continue
        meta = profile_parent.lstat()
        trial.require(profile_parent.resolve() == profile_parent and stat.S_ISDIR(meta.st_mode)
            and meta.st_uid == cfg['uid'], 'UNSAFE_BROWSER_CLEANUP_DIRECTORY')
        shutil.rmtree(profile_parent)

# An interrupted session transfer is cleaned before another experiment starts.
pending = list(runtime.glob('login-*.cookies'))
if pending:
    trial.stop_test()
    for path in pending:
        remove_browser_state(job/path.name.removesuffix('.cookies'))
        remove_cookie(path)
trial.require(not trial.uid_processes(cfg['uid']), 'BROWSER_UID_ALREADY_ACTIVE')
script = runtime/(RUN_NAME+'.py')
secret = runtime/(RUN_NAME+'.cookies')
asset_root = runtime/(RUN_NAME+'-source')
out = job/RUN_NAME
unit = 'bartosz-ote-'+RUN_NAME+'.service'
cg = pathlib.Path('/sys/fs/cgroup/user.slice')/cfg['slice']
receipt = {'schema':'ote-login-diagnostic-oracle:1', 'run_name':RUN_NAME,
    'mode':MODE, 'video_id':VIDEO, 'client':CLIENT, 'script_sha256':SCRIPT_HASH,
    'remote_evidence':str(evidence), 'status':'FAILED', 'files':{},
    'pending_session_cleanup_count':len(pending),
    'session_test':SESSION_ACTIVE, 'session_metadata':COOKIE_META if COOKIES else None,
    'persistent_session':PERSISTENT_SESSION, 'session_imported':bool(COOKIES) if PERSISTENT_SESSION else None,
    'parser_assets':{name:value['sha256'] for name,value in ASSETS.items()}}
started = staged_script = staged_assets = staged_secret = False
try:
    body = base64.b64decode(SCRIPT)
    trial.require(hashlib.sha256(body).hexdigest() == SCRIPT_HASH, 'DIAGNOSTIC_SCRIPT_HASH_MISMATCH')
    with script.open('xb') as stream: stream.write(body)
    staged_script = True
    script.chmod(0o644)
    if SESSION_ACTIVE:
        trial.require((VIDEO == 'aircAruvnKk' or PERSISTENT_SESSION) and ((MODE == 'ytdlp' and CLIENT in {'web','mweb'})
            or (MODE == 'native' and CLIENT is None)), 'SESSION_TEST_SCOPE_REQUIRED')
        cookie_body = auth_file.read_bytes() if PERSISTENT_SESSION else base64.b64decode(COOKIES, validate=True)
        trial.require(0 < len(cookie_body) <= 64*1024, 'COOKIE_EXPORT_SIZE_INVALID')
        if MODE == 'native':
            jar = http.cookiejar.MozillaCookieJar()
            jar._really_load(io.StringIO(cookie_body.decode()),'validated-export',True,True)
            entries = []
            for c in jar:
                trial.require(c.domain in {'.youtube.com','youtube.com'}, 'YOUTUBE_COOKIE_DOMAIN_REQUIRED')
                item = {'name':c.name,'value':c.value,'domain':c.domain,'path':c.path or '/',
                    'secure':bool(c.secure),'httpOnly':c.has_nonstandard_attr(http.cookiejar.HTTPONLY_ATTR)}
                if c.expires and c.expires > 0: item['expires'] = c.expires
                entries.append(item)
            cookie_body = (json.dumps(entries)+'\n').encode()
            trial.require(len(cookie_body) <= 65536, 'COOKIE_EXPORT_SIZE_INVALID')
        fd = os.open(secret, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
        staged_secret = True
        try:
            os.fchown(fd,cfg['uid'],cfg['gid'])
            os.fchmod(fd,0o600)
            with os.fdopen(fd,'wb',closefd=False) as stream: stream.write(cookie_body)
        finally: os.close(fd)
        del cookie_body
    if ASSETS:
        asset_root.mkdir(mode=0o755)
        # The broker's private umask must not hide these public parser files
        # from the isolated source UID. Secrets retain their separate 0700 path.
        asset_root.chmod(0o755)
        staged_assets = True
        for name,value in ASSETS.items():
            trial.require(name in {'apps/executor/python/transcript_ytdlp.py',
                'tools/gates/adapters/gate0_python_adapters.py','transcript-engine.mjs','dom-reader.js',
                'pot-transport-trace.mjs'}, 'FIXED_PARSER_ASSET_REQUIRED')
            data = base64.b64decode(value['base64'],validate=True)
            trial.require(hashlib.sha256(data).hexdigest() == value['sha256'], 'PARSER_ASSET_HASH_MISMATCH')
            target = asset_root/name
            target.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
            parent = target.parent
            while parent != asset_root:
                parent.chmod(0o755)
                parent = parent.parent
            with target.open('xb') as stream: stream.write(data)
            target.chmod(0o644)
    out.mkdir(mode=0o700)
    os.chown(out, cfg['uid'], cfg['gid'])
    started = True
    manager = trial.cmd(['/usr/bin/systemctl','start','user@30000.service'])
    trial.require(manager['exit_code'] == 0, 'USER_MANAGER_START_FAILED')
    boundary = trial.cgroup_sample(cg)
    trial.require(boundary['memory.max'] == '805306368' and boundary['memory.swap.max'] == '0'
        and boundary['cpu.max'] == '50000 100000', 'EXISTING_KERNEL_BOUNDARY_REQUIRED')
    receipt['boundary'] = {key:boundary[key] for key in ['memory.max','memory.swap.max','cpu.max']}
    python = '/opt/bartosz-intelligence/runtime/python/bin/python'
    diagnostic = [python, '-I', '-B', str(script), MODE, str(out), '--video', VIDEO,
        '--max-requests', str(MAX_REQUESTS)]
    if CLIENT: diagnostic += ['--client', CLIENT]
    if SESSION_ACTIVE: diagnostic += ['--cookies',str(secret)]
    if PERSISTENT_SESSION: diagnostic += ['--persistent-session']
    if ADAPTER: diagnostic += ['--adapter', '--item-id', ITEM_ID]
    if DEFAULT_AUDIO_LANGUAGE: diagnostic += ['--default-audio-language', DEFAULT_AUDIO_LANGUAGE]
    if MODE == 'ytdlp': diagnostic += ['--parser',str(asset_root/'apps/executor/python/transcript_ytdlp.py')]
    if MODE == 'native': diagnostic += ['--engine',str(asset_root/'transcript-engine.mjs')]
    if POT_SERVER:
        diagnostic += ['--pot-server',POT_SERVER,'--pot-trace',str(asset_root/'pot-transport-trace.mjs')]
    if POT_PLAYER: diagnostic += ['--pot-player']
    command = ['/usr/bin/systemd-run', '--unit='+unit, '--slice='+cfg['slice'],
        '--property=User=bartosz-browser', '--property=Group=bartosz-browser',
        '--property=UMask=0077', '--property=RuntimeMaxSec='+str(TIMEOUT_SECONDS)+'s',
        '--property=TimeoutStopSec=10s', '--property=KillMode=control-group',
        '--property=Restart=no', '--property=MemoryMax=768M', '--property=MemorySwapMax=0',
        '--property=TasksMax=256', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
        'HOME='+str(home), 'TMPDIR='+str(job), 'LANG=C.UTF-8',
        '/usr/bin/python3', '-I', str(runtime/'supervise.py'),
        '--output', str(out/'resources.json'), '--memory-mib', '768', '--timeout', str(TIMEOUT_SECONDS),
        '--memory-cgroup', str(cg), '--', *diagnostic]
    launch = trial.cmd(command)
    receipt['launch'] = {'exit_code':launch['exit_code']} if SESSION_ACTIVE else launch
    trial.require(launch['exit_code'] == 0, 'DIAGNOSTIC_UNIT_START_FAILED')
    deadline = time.monotonic()+TIMEOUT_SECONDS+10
    while time.monotonic() < deadline:
        state = trial.cmd(['/usr/bin/systemctl','show',unit,
            '--property=ActiveState,SubState,Result,ExecMainStatus'])
        fields = dict(line.split('=',1) for line in state['stdout'].splitlines() if '=' in line)
        if fields.get('ActiveState') not in {'active','activating','deactivating'}:
            receipt['unit_result'] = fields
            break
        time.sleep(0.25)
    else:
        raise RuntimeError('DIAGNOSTIC_UNIT_DEADLINE')
except Exception as error:
    receipt['error_code'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
finally:
    if started:
        try: receipt['unit_stop'] = trial.cmd(['/usr/bin/systemctl','stop',unit])
        except Exception: receipt['cleanup_error'] = 'DIAGNOSTIC_UNIT_STOP_FAILED'
        try: receipt['cleanup'] = trial.stop_test()
        except Exception as error: receipt['cleanup_error'] = type(error).__name__
    if PERSISTENT_SESSION and staged_secret:
        try:
            result_path = out/'result.json'
            value = json.loads(result_path.read_text()) if result_path.exists() else {}
            resources_path = out/'resources.json'
            resources_value = json.loads(resources_path.read_text()) if resources_path.exists() else {}
            receipt['session_updated'] = False
            trial.require(not trial.uid_processes(cfg['uid']), 'SESSION_UPDATE_REQUIRES_IDLE_UID')
            if value.get('status') == 'CAPTIONS_RECEIVED' and value.get('watch_logged_in') is True and type(value.get('cue_count')) is int and value['cue_count'] > 0 and resources_value.get('category') == 'NONE' and resources_value.get('exit_code') == 0:
                secure_file(secret)
                canonical,_ = validate_cookie_export(secret.read_bytes())
                atomic_session(canonical)
                del canonical
                receipt['session_updated'] = True
            receipt['authentication_status'] = 'AUTHENTICATED' if value.get('watch_logged_in') is True else 'REAUTH_REQUIRED' if value.get('watch_logged_in') is False or any(p.get('status') == 'LOGIN_REQUIRED' for p in value.get('players',[])) else 'UNKNOWN'
            receipt['persistent_session_retained'] = auth_file.exists()
            receipt['session_directory_mode'] = oct(stat.S_IMODE(auth_dir.stat().st_mode))
            receipt['session_file_mode'] = oct(stat.S_IMODE(auth_file.stat().st_mode))
        except Exception: receipt['cleanup_error'] = 'PERSISTENT_SESSION_UPDATE_FAILED'
    if SESSION_ACTIVE:
        if MODE == 'native':
            try: remove_browser_state(out)
            except Exception: receipt['cleanup_error'] = 'BROWSER_STATE_CLEANUP_FAILED'
            receipt['browser_state_removed'] = not (out/'browser-tmp').exists()
        if staged_secret:
            try: remove_cookie(secret)
            except Exception: receipt['cleanup_error'] = 'SESSION_SECRET_CLEANUP_FAILED'
        receipt['session_secret_removed'] = not secret.exists() and not secret.is_symlink()
    if POT_SERVER:
        try: remove_browser_state(out)
        except Exception: receipt['cleanup_error'] = 'POT_STATE_CLEANUP_FAILED'
        receipt['pot_state_removed'] = not (out/'pot-private').exists()
    if staged_assets:
        try:
            trial.require(asset_root.resolve() == asset_root, 'UNSAFE_PARSER_CLEANUP_ROOT')
            for name in ASSETS:
                target = asset_root/name
                if not target.exists(): continue
                meta = target.lstat()
                trial.require(stat.S_ISREG(meta.st_mode) and meta.st_uid == 0
                    and meta.st_nlink == 1 and not meta.st_mode & 0o022, 'UNSAFE_PARSER_CLEANUP_FILE')
                target.unlink()
            for name in ['apps/executor/python','apps/executor','apps',
                         'tools/gates/adapters','tools/gates','tools','']:
                directory = asset_root/name
                if directory.exists():
                    meta = directory.lstat()
                    trial.require(stat.S_ISDIR(meta.st_mode) and meta.st_uid == 0
                        and not meta.st_mode & 0o022, 'UNSAFE_PARSER_CLEANUP_DIRECTORY')
                    directory.rmdir()
        except Exception: receipt['cleanup_error'] = 'PARSER_ASSET_CLEANUP_FAILED'
    if ASSETS: receipt['parser_assets_removed'] = not asset_root.exists()
    if staged_script and script.exists() and not script.is_symlink(): script.unlink()
    receipt['staged_script_removed'] = not script.exists()

# Only direct regular output files are read, after every worker has stopped.
trial.require(not trial.uid_processes(cfg['uid']), 'BROWSER_UID_NOT_IDLE_AFTER_DIAGNOSTIC')
trial.require(not SESSION_ACTIVE or receipt.get('session_secret_removed'), 'SESSION_SECRET_CLEANUP_REQUIRED')
total = 0
if out.exists():
    for path in sorted(out.iterdir()):
        if path.suffix not in {'.json','.txt','.raw'}: continue
        fd = os.open(path, os.O_RDONLY|os.O_NOFOLLOW)
        try:
            meta = os.fstat(fd)
            trial.require(stat.S_ISREG(meta.st_mode) and meta.st_uid == cfg['uid']
                and meta.st_nlink == 1 and meta.st_size <= 8*1024*1024, 'UNSAFE_DIAGNOSTIC_ARTIFACT')
            with os.fdopen(fd, 'rb', closefd=False) as stream: data = stream.read(8*1024*1024+1)
        finally: os.close(fd)
        total += len(data)
        trial.require(total <= 32*1024*1024 and len(receipt['files']) < 64, 'DIAGNOSTIC_OUTPUT_LIMIT')
        saved = evidence/path.name
        with saved.open('xb') as stream: stream.write(data)
        saved.chmod(0o600)
        item = {'sha256':hashlib.sha256(data).hexdigest(), 'bytes':len(data),
            'base64':base64.b64encode(data).decode()}
        receipt['files'][path.name] = item
        if path.name in {'result.json','resources.json'}:
            receipt[path.stem] = json.loads(data)
resources = receipt.get('resources', {})
if 'error_code' not in receipt and 'cleanup_error' not in receipt and 'result' in receipt \
    and resources.get('category') == 'NONE' and resources.get('exit_code') == 0 \
    and receipt.get('staged_script_removed'):
    receipt['status'] = 'COMPLETED'
trial.write('receipt.json', receipt)
print(json.dumps({'status':receipt['status'],'result_status':receipt.get('result',{}).get('status'),
    'authentication_status':receipt.get('authentication_status'),'receipt':str(evidence/'receipt.json')}
    if ON_ORACLE else receipt, ensure_ascii=False))
raise SystemExit(0 if receipt['status'] == 'COMPLETED' else 2)
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--key', type=Path)
    parser.add_argument('--on-oracle', action='store_true')
    parser.add_argument('--script', type=Path, required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--mode', choices=['watch', 'panel', 'library', 'ytdlp', 'native', 'pot'], default='watch')
    parser.add_argument('--video', default='aircAruvnKk')
    parser.add_argument('--client')
    parser.add_argument('--cookies', type=Path)
    parser.add_argument('--pot-server')
    parser.add_argument('--pot-player', action='store_true')
    parser.add_argument('--persistent-session', action='store_true')
    parser.add_argument('--replace-session', action='store_true')
    parser.add_argument('--adapter', action='store_true')
    parser.add_argument('--item-id')
    parser.add_argument('--default-audio-language')
    parser.add_argument('--max-requests', type=int, choices=range(1, 9), default=8)
    parser.add_argument('--timeout-seconds', type=int, choices=range(1, 101), default=100)
    args = parser.parse_args()
    if not args.on_oracle and (not args.key or not args.output):
        parser.error('--key and --output required on Windows')
    if args.persistent_session and (args.mode != 'ytdlp' or args.client != 'mweb' or not args.pot_server):
        parser.error('persistent session requires existing mweb and Subs provider')
    if args.adapter and not args.persistent_session:
        parser.error('executor adapter requires protected persistent session')
    if args.adapter and not (args.item_id and re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', args.item_id)):
        parser.error('executor adapter requires a valid item ID')
    if args.default_audio_language is not None and (not args.adapter or len(args.default_audio_language) > 64 \
            or not re.fullmatch(r'[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*', args.default_audio_language)):
        parser.error('verified default audio language must be a language tag for the executor adapter')
    if args.replace_session and not (args.persistent_session and args.cookies):
        parser.error('replacement requires a new explicit persistent session export')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,48}', args.label):
        parser.error('label must contain lowercase letters, digits and hyphens, maximum 49 characters')
    if not re.fullmatch(r'[A-Za-z0-9_-]{11}', args.video):
        parser.error('video must be a YouTube video ID')
    if args.client and not re.fullmatch(r'[a-z0-9_]{1,32}', args.client):
        parser.error('invalid client')
    if args.mode == 'pot' or args.pot_server:
        if args.mode not in {'pot','ytdlp'} or not args.pot_server or (args.video != 'aircAruvnKk' and not args.persistent_session) or not (args.pot_server == '/opt/bartosz-intelligence/browser-runtime/youtube-mweb/provider/server' or re.fullmatch(r'/home/bartosz-browser-runtime/snap/chromium/common/jobs/login-bgutils-prep-[0-9a-f]{8}/provider/server', args.pot_server)):
            parser.error('pinned provider scope required')
        if args.mode == 'pot' and args.cookies:
            parser.error('public provider check must not receive cookies')
        if args.mode == 'ytdlp' and args.client != 'mweb':
            parser.error('Subs provider requires mweb')
    if args.pot_player and (args.mode != 'ytdlp' or not args.pot_server or args.cookies):
        parser.error('Player attestation experiment must be anonymous mweb with pinned provider')
    cookies, cookie_meta = b'', None
    if args.cookies:
        if (args.video != 'aircAruvnKk' and not args.persistent_session) or not ((args.mode == 'ytdlp' and args.client in {None,'web','mweb'}) or (args.mode == 'native' and args.client is None)):
            parser.error('session test requires aircAruvnKk and an explicitly approved client/mode')
        if args.mode == 'ytdlp': args.client = args.client or 'web'
        try:
            with args.cookies.open('rb') as stream: cookie_body = stream.read(64*1024+1)
            cookies, cookie_meta = validate_cookie_export(cookie_body)
            del cookie_body
        except (ValueError, OSError) as error:
            parser.error(str(error) if isinstance(error, ValueError) else 'COOKIE_EXPORT_READ_FAILED')
    body = args.script.read_bytes()
    if not body or len(body) > 1024*1024:
        parser.error('diagnostic script must contain between 1 byte and 1 MiB')
    run_name = 'login-'+args.label+'-'+uuid4().hex[:8]
    # Preserve only the public input script, never the generated SSH source.
    snapshot = None
    if not args.on_oracle:
        snapshot = args.output.parent/(run_name+'-diagnostic.py')
        snapshot.parent.mkdir(parents=True, exist_ok=True)
        with snapshot.open('xb') as stream: stream.write(body)
    assets = {}
    if args.mode == 'ytdlp':
        for name in ['apps/executor/python/transcript_ytdlp.py',
                     'tools/gates/adapters/gate0_python_adapters.py']:
            data = (HERE.parents[1]/name).read_bytes()
            assets[name] = {'base64':base64.b64encode(data).decode(), 'sha256':sha256(data).hexdigest()}
    if args.mode == 'native':
        if not args.cookies: parser.error('native diagnostic requires an explicitly shared session export')
        for name in ['transcript-engine.mjs','dom-reader.js']:
            data = (HERE.parents[1]/'.local/login-diagnostic/native-session-bundle'/name).read_bytes()
            assets[name] = {'base64':base64.b64encode(data).decode(), 'sha256':sha256(data).hexdigest()}
    if args.pot_server:
        data = (HERE/'pot-transport-trace.mjs').read_bytes()
        assets['pot-transport-trace.mjs'] = {'base64':base64.b64encode(data).decode(), 'sha256':sha256(data).hexdigest()}
    source = '\n'.join(name+'='+repr(value) for name, value in {
        'RUN_NAME': run_name, 'MODE': args.mode, 'VIDEO': args.video, 'CLIENT': args.client,
        'SCRIPT': base64.b64encode(body).decode(), 'SCRIPT_HASH': sha256(body).hexdigest(),
        'COOKIES': base64.b64encode(cookies).decode() if cookies else None,
        'COOKIE_META': cookie_meta, 'ASSETS':assets,
        'POT_SERVER':args.pot_server,
        'POT_PLAYER':args.pot_player,
        'PERSISTENT_SESSION':args.persistent_session, 'ON_ORACLE':args.on_oracle,
        'REPLACE_SESSION':args.replace_session,
        'ADAPTER':args.adapter,
        'ITEM_ID':args.item_id,
        'DEFAULT_AUDIO_LANGUAGE':args.default_audio_language,
        'MAX_REQUESTS':args.max_requests, 'TIMEOUT_SECONDS':args.timeout_seconds,
    }.items())+'\nfrom http.cookiejar import HTTPONLY_ATTR, LoadError, MozillaCookieJar\nimport io,warnings\n'+inspect.getsource(validate_cookie_export)+'\n'+REMOTE
    if args.on_oracle:
        exec(compile(source,'retained-oracle-job','exec'),{})
        return 0
    sys.path.insert(0, str(HERE / 'sandbox'))
    from diagnose import ssh
    command = ssh(args.key)
    command[-1] = ('env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin sudo -n /usr/bin/env -i '
        'PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 /usr/bin/python3 -I -B -')
    run = subprocess.run(command, input=source.encode(), capture_output=True, timeout=190)
    try:
        receipt = json.loads(run.stdout)
    except (ValueError, UnicodeError):
        receipt = {'schema': 'ote-login-diagnostic-oracle:1', 'status': 'FAILED',
            'error_code': 'REMOTE_RECEIPT_MISSING', 'stderr': run.stderr.decode('utf-8', 'replace')[-8192:]}
    receipt['ssh_exit_code'] = run.returncode
    receipt['diagnostic_script_snapshot'] = str(snapshot.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    if receipt.get('files'):
        artifacts = args.output.parent/run_name
        artifacts.mkdir()
        for name, item in receipt['files'].items():
            if Path(name).name != name: raise RuntimeError('UNSAFE_REMOTE_ARTIFACT_NAME')
            data = base64.b64decode(item['base64'], validate=True)
            if sha256(data).hexdigest() != item['sha256']: raise RuntimeError('REMOTE_ARTIFACT_HASH_MISMATCH')
            (artifacts/name).write_bytes(data)
    print(json.dumps({'status': receipt['status'], 'mode': args.mode, 'label': args.label,
        'receipt': str(args.output.resolve()), 'remote_exit': run.returncode,
        'result_status': receipt.get('result', {}).get('status'),
        'error_code': receipt.get('error_code'), 'artifact_count': len(receipt.get('files', {}))}))
    return run.returncode


if __name__ == '__main__':
    raise SystemExit(main())
