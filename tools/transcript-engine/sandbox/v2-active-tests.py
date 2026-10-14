"""Future, separately authorized tests of an ALREADY installed v2 policy.

Default execution performs no subprocess, browser, policy or runtime operation.
This file never installs a runtime, loads a policy, changes sysctl or contacts an
external source. An authorized administrator is an observer only; every browser,
payload control and profile-transition probe runs as UID 997/GID 988.

No claim of protection is based on LD_TRACE_LOADED_OBJECTS. A constructor marker
proves the preload fixture executes in a positive control. The PATH fixture is a
byte-identical copy of a trusted libz with a real ctypes mapping/ABI control. An
AppArmor denial must match the actual process, enforced profile and fixture path.
"""
from __future__ import annotations

import argparse
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time

HERE = Path(__file__).absolute().parent
EXPECTED_ELF = '/opt/bartosz-intelligence/browser-runtimes/chromium-headless-shell-153.0.8010.12/chrome-headless-shell'
EXPECTED_PROFILE = 'bartosz-ote-chromium-153_0_8010_12-enforced-v2'
MEMORY_BYTES = 768 * 1024 * 1024
FIXED_ARGS = [
    '--headless=new', '--remote-debugging-pipe', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-extensions',
    '--disable-default-apps', '--disable-breakpad', '--disable-dev-shm-usage',
    '--autoplay-policy=user-gesture-required',
]
FORBIDDEN = {'--no-sandbox', '--disable-seccomp-filter-sandbox',
             '--disable-namespace-sandbox', '--disable-setuid-sandbox', '--single-process'}
AUDIT_FIELDS = {'apparmor', 'operation', 'class', 'profile', 'pid', 'comm', 'name',
                'requested_mask', 'denied_mask', 'error', 'info', 'capname'}
AUDIT_PATTERN = re.compile(r'([A-Za-z_]+)=(?:"([^"\n]*)"|([^\s]+))')


class Rejected(RuntimeError):
    pass


def require(condition, code):
    if not condition:
        raise Rejected(code)


def file_hash(path):
    h = sha256()
    with Path(path).open('rb') as stream:
        while True:
            block = stream.read(1024 * 1024)
            if not block:
                return h.hexdigest()
            h.update(block)


def supervisor_path():
    # Review packets keep the original sandbox/../supervise.py layout. The
    # flat offline packet includes a hashed copy without ever executing it.
    flat = HERE / 'supervise.py'
    return flat if flat.is_file() else HERE.parent / 'supervise.py'


def sources(config_path, lock_path):
    selected = [Path(__file__), HERE / 'enforced.py', HERE / 'positive.py',
                supervisor_path(), config_path, lock_path]
    return {str(path.absolute()): file_hash(path) if path.is_file() else None
            for path in selected}


def blocked(config_path, lock_path):
    return {'schema': 'ote-v2-active-boundary-tests:1',
            'LIBRARY_BOUNDARY_READINESS': 'BLOCKED_ACTIVE_POLICY_APPROVAL',
            'SANDBOX_DEPLOYMENT_READINESS': 'BLOCKED_ACTIVE_POLICY_APPROVAL',
            'LIVE_SOURCE_ACCESS': 'BLOCKED_AUTHORIZATION', 'accepted': False,
            'browser_executions': 0, 'subprocess_executions': 0,
            'profile_loads': 0, 'host_configuration_changes': 0,
            'source_sha256': sources(config_path, lock_path),
            'argv_boundary': 'APPARMOR_DOES_NOT_FILTER_ARGV; launcher rejects disabling flags; direct ELF bypass remains outside that guarantee'}


def trusted(path):
    """Guard code imported/executed by the future root observer before import."""
    path = Path(path).absolute()
    for entry in [*reversed(path.parents), path]:
        meta = entry.lstat()
        require(not stat.S_ISLNK(meta.st_mode) and meta.st_uid == 0 and
                not (meta.st_mode & 0o022), 'OBSERVER_PACKET_NOT_ROOT_OWNED:' + str(entry))


def audit_event(message, timestamp=None):
    fields = {match.group(1): match.group(2) if match.group(2) is not None else match.group(3)
              for match in AUDIT_PATTERN.finditer(message)
              if match.group(1) in AUDIT_FIELDS}
    return {**fields, 'timestamp_us': timestamp,
            'message_sha256': sha256(message.encode()).hexdigest()}


def matching_mmap_denials(events, pid, profile, path):
    """A syntax error, missing DSO or generic EPERM never satisfies this test."""
    return [event for event in events
            if event.get('apparmor') == 'DENIED'
            and event.get('operation') == 'file_mmap'
            and event.get('pid') == str(pid)
            and event.get('profile') == profile
            and event.get('name') == str(path)
            and 'm' in event.get('requested_mask', '')
            and 'm' in event.get('denied_mask', '')]


def kernel_events(started, ended, profile):
    command = ['/usr/bin/journalctl', '--kernel', '--no-pager', '--output=json',
               '--since=@' + str(max(0, int(started) - 1)),
               '--until=@' + str(int(ended) + 2)]
    p = subprocess.run(command, capture_output=True, timeout=8,
                       env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
    require(p.returncode == 0, 'KERNEL_AUDIT_UNAVAILABLE')
    require(len(p.stdout) <= 4 * 1024 * 1024, 'KERNEL_AUDIT_OUTPUT_LIMIT')
    events = []
    for line in p.stdout.splitlines():
        row = json.loads(line)
        message = row.get('MESSAGE', '')
        if not isinstance(message, str) or profile not in message:
            continue
        event = audit_event(message, row.get('__REALTIME_TIMESTAMP'))
        if event.get('profile') == profile:
            events.append(event)
    return events


def process_identity(pid):
    path = Path('/proc') / str(pid)
    fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
    status = {}
    for line in (path / 'status').read_text().splitlines():
        key, _, value = line.partition(':')
        if key in {'Uid', 'Gid', 'CapEff', 'CapAmb', 'CapPrm', 'CapInh', 'NoNewPrivs', 'NSpid',
                   'Seccomp', 'Seccomp_filters'}:
            status[key] = value.strip()
    return {'pid': pid, 'start_ticks': fields[19], 'exe': os.readlink(path / 'exe'),
            'apparmor': (path / 'attr/current').read_text().strip(), **status}


def isolation_evidence(c, browser, renderer, observer):
    """Require host identity plus the existing renderer kernel evidence."""
    for item in [browser, renderer]:
        require(all(int(item.get(key, '-1'), 16) == 0 for key in
                    ['CapEff', 'CapAmb', 'CapPrm', 'CapInh']), 'HOST_CAPABILITIES_PRESENT')
    require(browser['namespaces'] == observer['namespaces'], 'BROWSER_NOT_IN_OBSERVED_HOST_NAMESPACES')
    require(renderer.get('uid_map', '').split() == [str(c['uid']), str(c['uid']), '1'], 'UNEXPECTED_RENDERER_UID_MAP')
    require(renderer.get('gid_map', '').split() == [str(c['gid']), str(c['gid']), '1'], 'UNEXPECTED_RENDERER_GID_MAP')


def executable_maps(pid, lock, executable):
    """Inspect the live process, distinguishing filesystem mappings from JIT."""
    identity_before = process_identity(pid)
    data = Path(f'/proc/{pid}/maps').read_bytes()
    require(len(data) <= 2 * 1024 * 1024, 'PROC_MAPS_OUTPUT_LIMIT')
    rows, nonfilesystem = [], []
    allowed = set(lock['files']) | {executable}
    for line in data.decode().splitlines():
        fields = line.split(maxsplit=5)
        if len(fields) < 2 or 'x' not in fields[1]:
            continue
        path = fields[5] if len(fields) == 6 else ''
        row = {'address': fields[0], 'permissions': fields[1], 'path': path}
        if path.startswith('/') and not path.startswith('/memfd:'):
            require(not path.endswith(' (deleted)'), 'DELETED_EXECUTABLE_FILESYSTEM_MAP')
            require(path in allowed, 'UNAPPROVED_EXECUTABLE_FILESYSTEM_MAP:' + path)
            # A host pathname alone misses pre-exec mount aliases. Compare the
            # real mapping's backing inode and bytes, not a same-named host file.
            backing = Path(f'/proc/{pid}/map_files/{fields[0]}')
            approved = Path(path).stat()
            mapped = backing.stat()
            require((mapped.st_dev, mapped.st_ino) == (approved.st_dev, approved.st_ino),
                    'EXECUTABLE_MAPPING_BACKING_CHANGED:' + path)
            require(file_hash(backing) == lock['files'][path]['sha256'], 'EXECUTABLE_MAPPING_BYTES_CHANGED:' + path)
            row.update({'device': fields[3], 'inode': fields[4], 'backing_sha256': lock['files'][path]['sha256'],
                        'backing_device_inode_verified': True})
            rows.append(row)
        else:
            # V8 JIT, anonymous executable memory and memfd are NOT an allowlist
            # of native code provenance; the remaining risk is explicit.
            nonfilesystem.append(row)
    require(process_identity(pid)['start_ticks'] == identity_before['start_ticks'], 'PID_REUSE')
    return {'process': identity_before, 'maps_sha256': sha256(data).hexdigest(),
            'approved_executable_filesystem_maps': rows,
            'executable_nonfilesystem_maps': nonfilesystem,
            'all_native_code_provenance_claimed': False}


def run_uid(command, env, timeout=8):
    started = time.time()
    p = subprocess.run(command, user=997, group=988, extra_groups=[],
                       env=env, capture_output=True, timeout=timeout,
                       start_new_session=True)
    require(len(p.stdout) <= 65536 and len(p.stderr) <= 65536, 'CONTROL_OUTPUT_LIMIT')
    return p, {'exit_code': p.returncode, 'started_unix': started,
               'ended_unix': time.time(), 'stdout_sha256': sha256(p.stdout).hexdigest(),
               'stderr_sha256': sha256(p.stderr).hexdigest()}


def fixture_location(directory):
    directory = Path(directory)
    require(directory.is_absolute() and directory.parent == Path('/tmp') and
            re.fullmatch(r'bartosz-ote-profile-[A-Za-z0-9_-]+', directory.name),
            'FIXTURE_DIRECTORY_BOUNDARY')
    return directory


def tmp_anchor():
    fd = os.open('/tmp', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        meta = os.fstat(fd)
        require(stat.S_ISDIR(meta.st_mode) and meta.st_uid == 0 and
                stat.S_IMODE(meta.st_mode) == 0o1777, 'FIXTURE_TMP_ANCHOR')
        return fd
    except Exception:
        os.close(fd)
        raise


def uid_fixture_directory(directory):
    """Open the account-owned directory without following a renamed symlink."""
    directory = fixture_location(directory)
    anchor = tmp_anchor()
    try:
        fd = os.open(directory.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW |
                     os.O_CLOEXEC, dir_fd=anchor)
        try:
            meta = os.fstat(fd)
            require(stat.S_ISDIR(meta.st_mode) and meta.st_uid == 997 and meta.st_gid == 988
                    and stat.S_IMODE(meta.st_mode) == 0o700, 'FIXTURE_DIRECTORY_METADATA')
            return fd
        except Exception:
            os.close(fd)
            raise
    finally:
        os.close(anchor)


def create_uid_fixture_directory(prefix):
    """Transfer only a pinned root-created FD; never chown a caller-owned name."""
    require(os.geteuid() == 0, 'ROOT_OBSERVER_ON_LINUX_REQUIRED')
    directory = fixture_location(tempfile.mkdtemp(prefix=prefix, dir='/tmp'))
    anchor = tmp_anchor()
    fd = -1
    try:
        fd = os.open(directory.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW |
                     os.O_CLOEXEC, dir_fd=anchor)
        meta = os.fstat(fd)
        require(stat.S_ISDIR(meta.st_mode) and meta.st_uid == 0 and
                stat.S_IMODE(meta.st_mode) == 0o700, 'FIXTURE_ROOT_CREATED_DIRECTORY')
        os.fchmod(fd, 0o700)
        os.fchown(fd, 997, 988)
        transferred = os.fstat(fd)
        require((transferred.st_dev, transferred.st_ino) == (meta.st_dev, meta.st_ino)
                and transferred.st_uid == 997 and transferred.st_gid == 988 and
                stat.S_IMODE(transferred.st_mode) == 0o700, 'FIXTURE_TRANSFER_CHANGED')
        return directory
    finally:
        if fd >= 0:
            os.close(fd)
        os.close(anchor)


def inspect_uid_fixture(path, limit=65536):
    """Bounded root read of a UID997 regular file through no-follow directory FDs.

    A caller-owned symlink, hardlink, pipe or concurrently changed inode cannot
    turn fixture inspection into access to a privileged observer's files.
    """
    path = Path(path)
    require(re.fullmatch(r'[A-Za-z0-9_.+-]+', path.name) and path.name not in {'.', '..'},
            'FIXTURE_FILE_NAME')
    require(type(limit) is int and 0 < limit <= 4 * 1024 * 1024, 'FIXTURE_INSPECTION_LIMIT')
    directory = fd = -1
    try:
        directory = uid_fixture_directory(path.parent)
        # O_NONBLOCK prevents a malicious FIFO from hanging before fstat.
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC |
                     os.O_NONBLOCK, dir_fd=directory)
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 997 and before.st_gid == 988
                and before.st_nlink == 1 and not (stat.S_IMODE(before.st_mode) & 0o7022),
                'FIXTURE_FILE_METADATA')
        require(0 <= before.st_size <= limit, 'FIXTURE_SIZE_LIMIT')
        blocks = []
        size = 0
        while True:
            block = os.read(fd, min(65536, limit + 1 - size))
            if not block:
                break
            size += len(block)
            require(size <= limit, 'FIXTURE_SIZE_LIMIT')
            blocks.append(block)
        after = os.fstat(fd)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_uid, value.st_gid,
                                  value.st_mode, value.st_nlink, value.st_size,
                                  value.st_mtime_ns, value.st_ctime_ns)
        require(identity(before) == identity(after), 'FIXTURE_CHANGED_DURING_READ')
        data = b''.join(blocks)
        require(len(data) == before.st_size, 'FIXTURE_READ_SIZE_CHANGED')
        return {'data': data, 'sha256': sha256(data).hexdigest(), 'bytes': len(data),
                'uid': before.st_uid, 'gid': before.st_gid, 'mode': stat.S_IMODE(before.st_mode)}
    except OSError as error:
        if isinstance(error, FileNotFoundError):
            raise
        raise Rejected('FIXTURE_NOFOLLOW_OPEN_FAILED') from error
    finally:
        if fd >= 0:
            os.close(fd)
        if directory >= 0:
            os.close(directory)


def uid_fixture_operation(source, arguments):
    p, receipt = run_uid(['/usr/bin/python3', '-I', '-c', source, *map(str, arguments)],
                         {'PATH': '/usr/bin:/bin', 'LANG': 'C'})
    require(p.returncode == 0, 'UID_FIXTURE_OPERATION_FAILED')
    return receipt


def cleanup_uid_fixture_directory(directory):
    """Refuse symlink replacement and use Python's fd-safe recursive cleanup."""
    directory = fixture_location(directory)
    require(shutil.rmtree.avoids_symlink_attacks, 'FD_SAFE_RMTREE_REQUIRED')
    anchor = tmp_anchor()
    fd = -1
    try:
        fd = os.open(directory.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW |
                     os.O_CLOEXEC, dir_fd=anchor)
        meta = os.fstat(fd)
        require(stat.S_ISDIR(meta.st_mode) and meta.st_uid == 997 and meta.st_gid == 988
                and stat.S_IMODE(meta.st_mode) == 0o700, 'FIXTURE_DIRECTORY_METADATA')
        uid_fixture_operation(r'''
import os,shutil,stat,sys
assert os.getuid()==997 and os.getgid()==988
assert shutil.rmtree.avoids_symlink_attacks
base=os.open('/tmp',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
try:
 d=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=base)
 try:
  s=os.fstat(d)
  assert s.st_uid==997 and s.st_gid==988 and stat.S_IMODE(s.st_mode)==0o700
  assert (s.st_dev,s.st_ino)==(int(sys.argv[2]),int(sys.argv[3]))
  n=os.stat(sys.argv[1],dir_fd=base,follow_symlinks=False)
  assert (n.st_dev,n.st_ino)==(s.st_dev,s.st_ino)
  shutil.rmtree(sys.argv[1],dir_fd=base)
 finally:os.close(d)
finally:os.close(base)
''', [directory.name, meta.st_dev, meta.st_ino])
        try:
            os.stat(directory.name, dir_fd=anchor, follow_symlinks=False)
        except FileNotFoundError:
            return True
        raise Rejected('FIXTURE_CLEANUP_PATH_REMAINS')
    except OSError as error:
        raise Rejected('FIXTURE_CLEANUP_NOFOLLOW_FAILED') from error
    finally:
        if fd >= 0:
            os.close(fd)
        os.close(anchor)


def existing_code_transition(c):
    # A successful change_profile retains previously mapped interpreter/native
    # code; checking ELF attachment alone cannot close this distinct route.
    source = r'''
import ctypes,json,os,sys
def current():
 try:return open('/proc/self/attr/current').read().strip()
 except OSError as e:return 'UNREADABLE:'+str(e.errno)
before=current();lib=ctypes.CDLL('libapparmor.so.1',use_errno=True)
lib.aa_change_profile.argtypes=[ctypes.c_char_p];lib.aa_change_profile.restype=ctypes.c_int
ctypes.set_errno(0);r=lib.aa_change_profile(sys.argv[1].encode());e=ctypes.get_errno();after=current()
libc=ctypes.CDLL(None,use_errno=True);ctypes.set_errno(0)
u=libc.unshare(0x10000000) if r==0 else None;ue=ctypes.get_errno() if r==0 else None
print(json.dumps({'pid':os.getpid(),'uid':os.getuid(),'before':before,'change_profile_return':r,
 'change_profile_errno':e,'after':after,'unshare_return':u,'unshare_errno':ue}))
'''
    p, receipt = run_uid(['/usr/bin/python3', '-I', '-c', source, c['apparmor_profile_name']],
                         {'PATH': '/usr/bin:/bin', 'LANG': 'C'})
    require(p.returncode == 0, 'PROFILE_TRANSITION_PROBE_FAILED')
    value = json.loads(p.stdout)
    require(value['uid'] == 997 and value['before'] == 'unconfined', 'INVALID_TRANSITION_BASELINE')
    return {**receipt, **value,
            'result': 'BLOCKER_EXISTING_CODE_PROFILE_TRANSITION' if value['change_profile_return'] == 0
                      else 'TRANSITION_REJECTED',
            'userns_result_is_separate_from_transition': True}


def payloads(directory, lock):
    """Compile a tiny constructor fixture with an existing compiler only."""
    cc = shutil.which('cc', path='/usr/bin:/bin')
    require(cc is not None, 'BLOCKED_FIXTURE_TOOLCHAIN_CC_REQUIRED')
    trusted(Path(cc).resolve())
    source = directory / 'payload.c'
    payload_source = r'''
#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>
__attribute__((constructor)) static void mark(void) {
 const char *p=getenv("OTE_TEST_MARKER"); if(!p) return;
 int f=open(p,O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW,0600);
 if(f>=0) { const char m[]="OTE_DSO_CONSTRUCTOR_EXECUTED\n"; write(f,m,sizeof(m)-1); close(f); }
}
'''
    uid_fixture_operation(r'''
import os,sys
assert os.getuid()==997 and os.getgid()==988
f=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
try:os.write(f,sys.argv[2].encode())
finally:os.close(f)
''', [source, payload_source])
    require(inspect_uid_fixture(source)['data'] == payload_source.encode(), 'PAYLOAD_SOURCE_CHANGED')
    dso = directory / 'libote_payload.so'
    p, compiled = run_uid([cc, '-shared', '-fPIC', '-Wl,-z,noexecstack', '-o', str(dso), str(source)],
                          {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'TMPDIR': str(directory)}, 20)
    require(p.returncode == 0, 'PAYLOAD_COMPILATION_FAILED')
    # Even these harmless permissions are changed by the owning UID, never by
    # the root observer following a caller-owned output filename.
    uid_fixture_operation(r'''
import os,stat,sys
assert os.getuid()==997 and os.getgid()==988
f=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
try:
 s=os.fstat(f);assert stat.S_ISREG(s.st_mode) and s.st_uid==997 and s.st_nlink==1
 os.fchmod(f,0o600)
finally:os.close(f)
''', [dso])
    inspected_dso = inspect_uid_fixture(dso, 4 * 1024 * 1024)
    marker = directory / 'control-marker'
    source = 'import ctypes,json,os,sys; ctypes.CDLL(sys.argv[1]); print(json.dumps({"pid":os.getpid(),"uid":os.getuid()}))'
    p, control = run_uid(['/usr/bin/python3', '-I', '-c', source, str(dso)],
                         {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'OTE_TEST_MARKER': str(marker)})
    require(p.returncode == 0 and inspect_uid_fixture(marker)['data'] == b'OTE_DSO_CONSTRUCTOR_EXECUTED\n',
            'PAYLOAD_CONSTRUCTOR_POSITIVE_CONTROL_FAILED')
    uid_fixture_operation('import os,sys; assert os.getuid()==997; os.unlink(sys.argv[1])', [marker])
    candidates = [Path(name) for name, row in lock['files'].items()
                  if row.get('kind') == 'system' and Path(name).name.startswith('libz.so.1')]
    require(len(candidates) == 1, 'SINGLE_LOCKED_LIBZ_REQUIRED')
    original = candidates[0]
    copied = directory / 'libz.so.1'
    uid_fixture_operation(r'''
import os,shutil,sys
assert os.getuid()==997 and os.getgid()==988
output=os.open(sys.argv[2],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
with open(sys.argv[1],'rb') as source,os.fdopen(output,'wb') as target:
 shutil.copyfileobj(source,target,65536)
''', [original, copied])
    inspected_copy = inspect_uid_fixture(copied, 4 * 1024 * 1024)
    require(inspected_copy['sha256'] == lock['files'][str(original)]['sha256'], 'LIBZ_COPY_HASH')
    source = r'''
import ctypes,json,os,sys
lib=ctypes.CDLL(sys.argv[1],mode=os.RTLD_NOW);lib.zlibVersion.restype=ctypes.c_char_p
version=lib.zlibVersion().decode();maps=open('/proc/self/maps').read()
print(json.dumps({'pid':os.getpid(),'uid':os.getuid(),'version':version,'copy_mapped':sys.argv[1] in maps}))
'''
    p, copy_control = run_uid(['/usr/bin/python3', '-I', '-c', source, str(copied)],
                              {'PATH': '/usr/bin:/bin', 'LANG': 'C'})
    value = json.loads(p.stdout) if p.returncode == 0 else {}
    require(value.get('uid') == 997 and value.get('copy_mapped') is True and bool(value.get('version')),
            'LIBZ_REAL_MAPPING_ABI_CONTROL_FAILED')
    return dso, copied, {'compiler_sha256': file_hash(Path(cc).resolve()),
                         'constructor_dso_sha256': inspected_dso['sha256'], 'compiler': compiled,
                         'constructor_execution_control': control,
                         'libz_original': str(original), 'libz_sha256': inspected_copy['sha256'],
                         'libz_mapping_abi_control': {**copy_control, **value}}


def constructor_marker_present(marker):
    if marker is None:
        return False
    try:
        inspect_uid_fixture(marker)
        return True
    except FileNotFoundError:
        return False


def local_browser(c, lock, modules, launcher, extra_env=None, marker=None):
    """One bounded CDP launch; supports both direct ELF and approved launcher."""
    positive = modules['positive']
    state = {'requests': 0, 'external_requests_blocked': 0}
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state['requests'] += 1
            content = b'<!doctype html><meta charset=utf-8><div id="state">OTE_V2_LOOPBACK_OK</div>'
            self.send_response(200)
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        def log_message(self, *_):
            pass
    server = HTTPServer(('127.0.0.1', 0), Handler)
    profile = create_uid_fixture_directory('bartosz-ote-profile-')
    in_r, in_w = os.pipe()
    out_r, out_w = os.pipe()
    child = cdp = guard = server_thread = None
    stderr = bytearray()
    started = time.time()
    origin = f'http://127.0.0.1:{server.server_port}'
    receipt = {'started_unix': started, 'launch_kind': 'LAUNCHER' if launcher else 'DIRECT_ELF'}
    try:
        # Fault env must first appear at the target exec, never in the shell:
        # otherwise its loader could execute the constructor before AA attaches.
        injected = dict(extra_env or {})
        if marker:
            injected['OTE_TEST_MARKER'] = str(marker)
        command = ['/bin/sh', '-c', 'exec 3<&"$1" 4>&"$2"; shift 2; exec "$@"',
                   'ote-v2-cdp', str(in_r), str(out_w),
                   '/usr/bin/env', *[key + '=' + value for key, value in injected.items()],
                   c['launcher'] if launcher else c['executable'], *FIXED_ARGS,
                   '--user-data-dir=' + str(profile), 'about:blank']
        environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(profile),
                       'TMPDIR': str(profile)}
        child = subprocess.Popen(command, user=997, group=988, extra_groups=[],
                                 pass_fds=(in_r, out_w), env=environment,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.PIPE, start_new_session=True)
        receipt['pid'] = child.pid
        os.close(in_r); in_r = -1
        os.close(out_w); out_w = -1
        def drain():
            while True:
                data = child.stderr.read(4096)
                if not data:
                    return
                if len(stderr) + len(data) > 65536:
                    try: os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    return
                stderr.extend(data)
        stderr_thread = threading.Thread(target=drain, daemon=True)
        stderr_thread.start()
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        cdp = positive.CDP(in_w, out_r)
        version = cdp.call('Browser.getVersion')
        require(str(version.get('product', '')).endswith('/' + c['version']), 'BROWSER_VERSION_MISMATCH')
        pages = [row for row in cdp.call('Target.getTargets')['targetInfos'] if row['type'] == 'page']
        require(len(pages) == 1, 'SINGLE_FRESH_PAGE_REQUIRED')
        target = pages[0]['targetId']
        session = cdp.call('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
        cdp.call('Runtime.enable', session=session)
        cdp.call('Page.enable', session=session)
        guard = positive.RequestGuard(cdp, session, origin, state)
        cdp.call('Fetch.enable', {'patterns': [{'urlPattern': '*'}]}, session)
        cdp.call('Page.navigate', {'url': origin + '/'}, session)
        loaded = False
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            guard.check()
            value = cdp.call('Runtime.evaluate', {'expression': "document.getElementById('state')?.textContent",
                                                'returnByValue': True}, session)
            if value.get('result', {}).get('value') == 'OTE_V2_LOOPBACK_OK':
                loaded = True
                break
            time.sleep(0.05)
        require(loaded, 'LOCAL_PAGE_NOT_LOADED')
        main = positive.status(child.pid)
        observer = positive.status(os.getpid())
        main.update({key: process_identity(child.pid)[key] for key in ['CapPrm', 'CapInh']})
        require(main['apparmor'] == c['apparmor_profile_name'] + ' (enforce)', 'PROFILE_NOT_ENFORCED')
        require(all(int(main[key], 16) == 0 for key in ['CapEff', 'CapAmb', 'CapPrm', 'CapInh']), 'HOST_CAPABILITIES_PRESENT')
        process_maps = [executable_maps(child.pid, lock, c['executable'])]
        renderers = []
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit():
                continue
            try:
                pid = int(entry.name)
                argv = (entry / 'cmdline').read_bytes().split(b'\0')
                if b'--type=renderer' not in argv or os.getpgid(pid) != child.pid:
                    continue
                require(not {item.decode() for item in argv if item}.intersection(FORBIDDEN), 'UNSAFE_RENDERER_ARGV')
                require(os.readlink(entry / 'exe') == c['executable'], 'RENDERER_EXECUTABLE_MISMATCH')
                renderer = positive.status(pid)
                renderer.update({key: process_identity(pid)[key] for key in ['CapPrm', 'CapInh']})
                renderer['gid_map'] = (entry / 'gid_map').read_text().strip()
                positive.sandbox_assertions(c, main, renderer)
                isolation_evidence(c, main, renderer, observer)
                require(renderer['apparmor'] == c['apparmor_profile_name'] + ' (enforce)', 'RENDERER_PROFILE_NOT_ENFORCED')
                renderers.append({'pid': pid, **renderer})
                process_maps.append(executable_maps(pid, lock, c['executable']))
            except FileNotFoundError:
                continue
        require(bool(renderers), 'NO_VERIFIED_RENDERER')
        receipt.update({'result': 'LOCAL_PAGE_AND_KERNEL_ISOLATION_CONFIRMED',
                        'browser': main, 'renderers': renderers, 'live_process_maps': process_maps,
                        'page': state})
    except Exception as error:
        receipt.update({'result': 'BROWSER_OR_EVIDENCE_FAILURE',
                        'error': str(error) if isinstance(error, Rejected) else type(error).__name__})
    finally:
        if guard:
            guard.close()
        if cdp:
            try: cdp.call('Browser.close')
            except Exception: pass
        if child:
            try: os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            child.wait(timeout=5)
            stderr_thread.join(timeout=2)
            child.stderr.close()
            receipt['exit_code'] = child.returncode
        if server_thread:
            server.shutdown()
            server_thread.join(timeout=2)
        server.server_close()
        for fd in [in_r, in_w, out_r, out_w]:
            if fd >= 0:
                try: os.close(fd)
                except OSError: pass
        require(profile.parent == Path('/tmp') and profile.name.startswith('bartosz-ote-profile-'), 'CLEANUP_BOUNDARY')
        cleanup_uid_fixture_directory(profile)
        receipt.update({'ended_unix': time.time(), 'stderr_sha256': sha256(stderr).hexdigest(),
                        'temporary_profile_removed': True,
                        'constructor_marker_present': constructor_marker_present(marker)})
    return receipt


def active_worker(config_path, lock_path):
    require(sys.platform == 'linux' and os.geteuid() == 0, 'ROOT_OBSERVER_ON_LINUX_REQUIRED')
    require(sys.flags.isolated, 'ROOT_ISOLATED_ADMIN_REQUIRED')
    require(os.environ.get('BARTOSZ_OTE_SUPERVISED') == '1', '768_MIB_SUPERVISOR_REQUIRED')
    for path in [Path(__file__), config_path, lock_path, HERE / 'enforced.py',
                 HERE / 'positive.py', HERE / 'policy.py', supervisor_path()]:
        trusted(path)
    sys.path.insert(0, str(HERE))
    enforced = importlib.import_module('enforced')
    c = enforced.validate_config(json.loads(config_path.read_text()))
    lock = enforced.load_lock(lock_path)
    require(c['uid'] == 997 and c['gid'] == 988 and c['executable'] == EXPECTED_ELF
            and c['apparmor_profile_name'] == EXPECTED_PROFILE, 'UNEXPECTED_V2_TARGET')
    validation = enforced.validate_runtime(c, lock)
    require(file_hash(lock_path) == c['library_lock_sha256'], 'LOCK_FILE_HASH_MISMATCH')
    profile = Path(c['apparmor_profile_path'])
    enforced.validate_profile(c, lock, profile.read_text())
    loaded = Path('/sys/kernel/security/apparmor/profiles').read_text().splitlines()
    require(c['apparmor_profile_name'] + ' (enforce)' in loaded, 'V2_PROFILE_NOT_LOADED_ENFORCE')
    original_profiles = Path('/sys/kernel/security/apparmor/profiles').read_bytes()
    settings = {str(p): p.read_bytes() for p in [
        Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'),
        Path('/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined'),
        Path('/proc/sys/kernel/unprivileged_userns_clone')]}
    result = {'schema': 'ote-v2-active-boundary-tests:1', 'accepted': False,
              'LIVE_SOURCE_ACCESS': 'BLOCKED_AUTHORIZATION', 'profile_loads': 0,
              'host_configuration_changes': 0, 'root_browser_executions': 0,
              'source_sha256': sources(config_path, lock_path), 'runtime_validation': validation,
              'memory_limit_bytes': MEMORY_BYTES, 'tests': {},
              'argv_boundary': 'APPARMOR_DOES_NOT_FILTER_ARGV; direct ELF can bypass launcher argv checks',
              'all_native_code_provenance_claimed': False}
    try:
        transition = existing_code_transition(c)
        result['tests']['existing_code_change_profile'] = transition
        if transition['result'].startswith('BLOCKER'):
            result.update({'LIBRARY_BOUNDARY_READINESS': 'FAIL_EXISTING_CODE_PROFILE_TRANSITION',
                           'SANDBOX_DEPLOYMENT_READINESS': 'BLOCKED_SECURITY_MODEL',
                           'remaining_browser_tests': 'NOT_RUN_AFTER_CRITICAL_BOUNDARY_FAILURE'})
            return result
        positive = importlib.import_module('positive')
        modules = {'positive': positive}
        directory = create_uid_fixture_directory('bartosz-ote-profile-v2fixture-')
        try:
            dso, copied, controls = payloads(directory, lock)
            result['tests']['fixture_positive_controls'] = controls
            baseline = local_browser(c, lock, modules, True)
            result['tests']['positive_local_browser'] = baseline
            require(baseline['result'] == 'LOCAL_PAGE_AND_KERNEL_ISOLATION_CONFIRMED', 'POSITIVE_SANDBOX_FAILED')
            for name, selected, environment in [
                    ('direct_LD_PRELOAD', dso, {'LD_PRELOAD': str(dso)}),
                    ('direct_LD_LIBRARY_PATH', copied, {'LD_LIBRARY_PATH': str(directory)})]:
                marker = directory / (name + '-marker')
                run = local_browser(c, lock, modules, False, environment, marker)
                events = kernel_events(run['started_unix'], run['ended_unix'], c['apparmor_profile_name'])
                denials = matching_mmap_denials(events, run['pid'], c['apparmor_profile_name'], selected)
                run['matching_kernel_file_mmap_denials'] = denials
                require(not run['constructor_marker_present'], 'UNTRUSTED_CONSTRUCTOR_EXECUTED')
                require(bool(denials), 'NO_EXACT_PROCESS_MMAP_DENIAL:' + name)
                run['boundary_result'] = 'EXACT_PROFILE_PID_PATH_EXECUTABLE_MAPPING_DENIED'
                run['payload_execution_claim'] = ('CONSTRUCTOR_FIXTURE_VERIFIED_SEPARATELY'
                                                  if name == 'direct_LD_PRELOAD'
                                                  else 'ABI_IDENTICAL_COPY_MAPPING_DENIED; NOT_AN_EXECUTED_CONSTRUCTOR_TEST')
                result['tests'][name] = run
            # Rejection by the launcher is separate from an AppArmor argv policy.
            flag_profile = create_uid_fixture_directory('bartosz-ote-profile-')
            try:
                p, flags = run_uid([c['launcher'], *FIXED_ARGS,
                    '--user-data-dir=' + str(flag_profile), 'about:blank', '--no-sandbox'],
                    {'PATH': '/usr/bin:/bin', 'LANG': 'C'})
                rejection = json.loads(p.stderr)
                require(p.returncode == 78 and rejection.get('code') == 'UNAPPROVED_BROWSER_ARGUMENT',
                        'NO_EXPLICIT_LAUNCHER_FLAG_REJECTION')
            finally:
                cleanup_uid_fixture_directory(flag_profile)
            result['tests']['launcher_no_sandbox'] = {**flags, 'result': 'LAUNCHER_REJECTED',
                                                      'os_argv_rejection_claimed': False}
            result['temporary_fixture_removed_after_context'] = str(directory)
        finally:
            result['temporary_fixture_removed_after_context'] = cleanup_uid_fixture_directory(directory)
        result.update({'LIBRARY_BOUNDARY_READINESS': 'PASS_TESTED_FILESYSTEM_MAPPING_BOUNDARY',
                       'SANDBOX_DEPLOYMENT_READINESS': 'BLOCKED_DIRECT_ARGV_AND_ANONYMOUS_CODE_MODEL'})
        return result
    except Exception as error:
        result.update({'LIBRARY_BOUNDARY_READINESS': 'FAIL_CLOSED',
                       'SANDBOX_DEPLOYMENT_READINESS': 'BLOCKED_FAILED_ACCEPTANCE',
                       'error': str(error) if isinstance(error, Rejected) else type(error).__name__})
        return result
    finally:
        result['loaded_profiles_unchanged'] = Path('/sys/kernel/security/apparmor/profiles').read_bytes() == original_profiles
        result['global_settings_unchanged'] = settings == {path: Path(path).read_bytes() for path in settings}
        if not result['loaded_profiles_unchanged'] or not result['global_settings_unchanged']:
            result['LIBRARY_BOUNDARY_READINESS'] = 'FAIL_HOST_STATE_DRIFT'
            result['SANDBOX_DEPLOYMENT_READINESS'] = 'BLOCKED_HOST_STATE_DRIFT'


def supervised(config_path, lock_path):
    require(sys.platform == 'linux' and os.geteuid() == 0, 'ROOT_OBSERVER_ON_LINUX_REQUIRED')
    require(sys.flags.isolated, 'ROOT_ISOLATED_ADMIN_REQUIRED')
    for path in [Path(__file__), supervisor_path(), config_path, lock_path]:
        trusted(path)
    with tempfile.TemporaryDirectory(prefix='ote-v2-supervisor-') as name:
        directory = Path(name)
        receipt_path = directory / 'resources.json'
        command = ['/usr/bin/python3', '-I', str(supervisor_path()),
                   '--output', str(receipt_path), '--memory-mib', '768', '--timeout', '100', '--',
                   '/usr/bin/python3', '-I', str(Path(__file__).absolute()),
                   '--config', str(config_path), '--library-lock', str(lock_path),
                   '--owner-authorized-active-policy', '--active-worker',
                   '--output', str(directory / 'worker.json')]
        p = subprocess.run(command, capture_output=True, timeout=112,
                           env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
        receipt = json.loads(receipt_path.read_text())
        result = receipt.pop('child_result', None)
        require(isinstance(result, dict), 'ACTIVE_WORKER_RESULT_MISSING')
        result['supervisor'] = receipt
        if p.returncode != 0 or receipt['category'] != 'NONE' or receipt['descendants_remaining'] != 0:
            result['LIBRARY_BOUNDARY_READINESS'] = 'FAIL_SUPERVISOR_OR_CLEANUP'
            result['SANDBOX_DEPLOYMENT_READINESS'] = 'BLOCKED_FAILED_ACCEPTANCE'
        require(receipt['memory_limit_bytes'] == MEMORY_BYTES, 'MEMORY_LIMIT_CHANGED')
    result['supervisor_directory_removed'] = not directory.exists()
    return result


def write_result(output, result):
    data = (json.dumps(result, indent=2) + '\n').encode()
    output = Path(output).absolute()
    if os.name != 'posix' or os.geteuid() != 0:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(data)
        return
    # The root observer's receipt must also avoid caller-owned destination
    # names. A root-created private /tmp wrapper is safe under its sticky
    # anchor; every other ancestor must forbid writes by nonroot accounts.
    for entry in [*reversed(output.parent.parents), output.parent]:
        meta = entry.lstat()
        require(stat.S_ISDIR(meta.st_mode) and meta.st_uid == 0 and
                (not (meta.st_mode & 0o022) or
                 (entry == Path('/tmp') and stat.S_IMODE(meta.st_mode) == 0o1777)),
                'OBSERVER_RESULT_PARENT_NOT_TRUSTED')
    parent = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    fd = -1
    try:
        fd = os.open(output.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW |
                     os.O_CLOEXEC, 0o600, dir_fd=parent)
        with os.fdopen(fd, 'wb') as stream:
            fd = -1
            stream.write(data)
    finally:
        if fd >= 0:
            os.close(fd)
        os.close(parent)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=HERE / 'enforced-runtime.json')
    parser.add_argument('--library-lock', type=Path, default=HERE / 'v2-library-lock.json')
    parser.add_argument('--owner-authorized-active-policy', action='store_true')
    parser.add_argument('--active-worker', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not args.owner_authorized_active_policy:
        result = blocked(args.config, args.library_lock)
    else:
        try:
            result = (active_worker if args.active_worker else supervised)(args.config.absolute(), args.library_lock.absolute())
        except Exception as error:
            result = {'schema': 'ote-v2-active-boundary-tests:1', 'accepted': False,
                      'LIBRARY_BOUNDARY_READINESS': 'FAIL_CLOSED',
                      'SANDBOX_DEPLOYMENT_READINESS': 'BLOCKED_FAILED_ACCEPTANCE',
                      'LIVE_SOURCE_ACCESS': 'BLOCKED_AUTHORIZATION',
                      'error': str(error) if isinstance(error, Rejected) else type(error).__name__}
    write_result(args.output, result)
    print(json.dumps(result))
    return 0 if result['LIBRARY_BOUNDARY_READINESS'].startswith(('BLOCKED_ACTIVE_POLICY', 'PASS_')) else 2


if __name__ == '__main__':
    raise SystemExit(main())
