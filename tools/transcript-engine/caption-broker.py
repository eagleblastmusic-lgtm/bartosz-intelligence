"""One-operation local bridge from the executor to protected YouTube captions.

The broker accepts only caption process inputs from one configured local UID.
It never exposes cookie values, request URLs, arbitrary paths or shell commands.
List captures one selected source through the retained Oracle boundary; fetch
returns that capture from memory without repeating upstream requests.
"""
from __future__ import annotations

import argparse
import base64
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import stat
import struct
import subprocess
import sys
import time

RUNTIME = Path('/opt/bartosz-intelligence/browser-runtime/youtube-mweb')
EVIDENCE = Path('/root/bartosz-ote-chromium-deployment-20261014')
MAXIMUM = 4 * 1024 * 1024
INPUT_LIMIT = 8192
OUTPUT_LIMIT = 16 * 1024 * 1024
TRACK_FIELDS = {'language_code', 'track_kind', 'is_generated', 'is_translated',
    'source_language', 'translation_source_track_id', 'is_translatable',
    'translation_languages', 'is_original', 'extension'}
STOP_REQUESTED = False


class Cancelled(Exception):
    pass


def failure(code, status='TEMPORARY_FAILURE'):
    return {'status': status, 'failure_code': code, 'tracks': [],
        'video_language': None, 'selected': None, 'segments': [],
        'raw_payload_base64': None, 'raw_payload_hash': None,
        'upstream_requests': None, 'bytes_received': None}


def validate_input(value):
    if not isinstance(value, dict) or set(value) - {'operation', 'video_id', 'item_id',
            'max_bytes', 'language_code', 'track_kind', 'extension'}:
        raise ValueError('INVALID_LOCAL_INPUT')
    if value.get('operation') not in {'list', 'fetch'} or not isinstance(value.get('video_id'), str) \
            or not re.fullmatch(r'[A-Za-z0-9_-]{11}', value['video_id']):
        raise ValueError('INVALID_LOCAL_INPUT')
    if type(value.get('max_bytes')) is not int or not 1 <= value['max_bytes'] <= MAXIMUM:
        raise ValueError('INVALID_LOCAL_INPUT')
    if not isinstance(value.get('item_id'), str) or not re.fullmatch(
            r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', value['item_id']):
        raise ValueError('INVALID_LOCAL_INPUT')
    if value['operation'] == 'list':
        if set(value) != {'operation', 'video_id', 'item_id', 'max_bytes'}:
            raise ValueError('INVALID_LOCAL_INPUT')
    else:
        if set(value) != {'operation', 'video_id', 'item_id', 'max_bytes', 'language_code', 'track_kind', 'extension'}:
            raise ValueError('INVALID_LOCAL_INPUT')
        if not isinstance(value['language_code'], str) or not re.fullmatch(r'[A-Za-z0-9-]{1,64}', value['language_code']) \
                or value['track_kind'] not in {'MANUAL', 'GENERATED'} \
                or value['extension'] not in {'json3', 'vtt', 'srv3', 'xml', 'ttml'}:
            raise ValueError('INVALID_LOCAL_INPUT')
    return value


def public_track(value):
    if not isinstance(value, dict):
        raise ValueError('TRACK_CONTRACT_INVALID')
    result = {key: value.get(key) for key in TRACK_FIELDS}
    if not isinstance(result['language_code'], str) or not re.fullmatch(r'[A-Za-z0-9-]{1,64}', result['language_code']) \
            or result['track_kind'] not in {'MANUAL', 'GENERATED'} \
            or result['extension'] not in {'json3', 'vtt', 'srv3', 'xml', 'ttml'}:
        raise ValueError('TRACK_CONTRACT_INVALID')
    for field in ['is_generated', 'is_translated', 'is_translatable', 'is_original']:
        if result[field] is not None and type(result[field]) is not bool:
            raise ValueError('TRACK_CONTRACT_INVALID')
    if result['is_translated'] is not False or result['source_language'] is not None \
            or result['translation_source_track_id'] is not None \
            or result['translation_languages'] != []:
        raise ValueError('TRACK_CONTRACT_INVALID')
    return result


def same_track(left, right):
    return all(left.get(key) == right.get(key) for key in ['language_code', 'track_kind', 'extension'])


def connection_closed(connection):
    readable, _, _ = __import__('select').select([connection], [], [], 0)
    if not readable:
        return False
    try:
        return not connection.recv(1, socket.MSG_PEEK)
    except (ConnectionError, OSError):
        return True


def cancel_caption(child):
    # The fixed CLI launches the sole UID30000 caption job in the retained slice.
    # Stop that slice as well as the root CLI process group on caller disconnect.
    try:
        subprocess.run(['/usr/bin/systemctl', 'stop', 'user-30000.slice'],
            env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=12)
    except subprocess.TimeoutExpired: pass
    try: os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    try: child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        child.wait(timeout=3)


def check_root_file(path):
    if path.resolve() != path:
        raise ValueError('BROKER_RUNTIME_INTEGRITY')
    for parent in [*reversed(path.parent.parents), path.parent]:
        meta = parent.lstat()
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022:
            raise ValueError('BROKER_RUNTIME_INTEGRITY')
    meta = path.lstat()
    if not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022 or meta.st_nlink != 1:
        raise ValueError('BROKER_RUNTIME_INTEGRITY')


def cleanup_run(path):
    """Prune only this broker capture's duplicate text and private work state."""
    if path.parent.parent != EVIDENCE or path.name != 'receipt.json' \
            or not re.fullmatch(r'login-caption-broker-[0-9a-f]{8}', path.parent.name):
        raise ValueError('BROKER_RECEIPT_PATH_INVALID')
    run = path.parent.name
    job = Path('/home/bartosz-browser-runtime/snap/chromium/common/jobs')/run
    runtime = Path('/opt/bartosz-intelligence/browser-runtime')
    # No cleanup occurs until the controller has stopped all caption processes.
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit(): continue
        try:
            uid = next(line for line in (entry/'status').read_text().splitlines()
                if line.startswith('Uid:')).split()[1]
            if uid == '30000': raise ValueError('BROKER_CLEANUP_UID_NOT_IDLE')
        except (OSError, StopIteration): pass
    for directory in [path.parent, job]:
        if not directory.exists(): continue
        if directory.resolve() != directory:
            raise ValueError('BROKER_CLEANUP_DIRECTORY_INVALID')
        for name in ['caption.raw', 'segments.json', 'transcript.txt']:
            target = directory/name
            if not target.exists(): continue
            meta = target.lstat()
            if not stat.S_ISREG(meta.st_mode) or meta.st_uid not in {0, 30000} or meta.st_nlink != 1:
                raise ValueError('BROKER_CLEANUP_FILE_INVALID')
            target.unlink()
    secret = runtime/(run+'.cookies')
    if secret.exists():
        meta = secret.lstat()
        if secret.resolve() != secret or not stat.S_ISREG(meta.st_mode) or meta.st_uid != 30000 \
                or meta.st_nlink != 1 or stat.S_IMODE(meta.st_mode) != 0o600:
            raise ValueError('BROKER_CLEANUP_SECRET_INVALID')
        secret.unlink()
    for name in ['pot-private', 'browser-tmp']:
        target = job/name
        if not target.exists(): continue
        meta = target.lstat()
        if target.resolve() != target or not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 30000:
            raise ValueError('BROKER_CLEANUP_DIRECTORY_INVALID')
        __import__('shutil').rmtree(target)
    script = runtime/(run+'.py')
    if script.exists():
        check_root_file(script)
        script.unlink()
    assets = runtime/(run+'-source')
    if assets.exists():
        if assets.resolve() != assets or assets.stat().st_uid != 0:
            raise ValueError('BROKER_CLEANUP_DIRECTORY_INVALID')
        allowed = {'apps/executor/python/transcript_ytdlp.py',
            'tools/gates/adapters/gate0_python_adapters.py', 'pot-transport-trace.mjs'}
        for directory, subdirs, files in os.walk(assets, followlinks=False):
            for name in [*subdirs, *files]:
                item = Path(directory)/name
                if item.is_symlink() or item.stat().st_uid != 0:
                    raise ValueError('BROKER_CLEANUP_DIRECTORY_INVALID')
            for name in files:
                item = Path(directory)/name
                if item.relative_to(assets).as_posix() not in allowed:
                    raise ValueError('BROKER_CLEANUP_FILE_INVALID')
                check_root_file(item)
        __import__('shutil').rmtree(assets)
    if path.exists():
        check_root_file(path)
        receipt = json.loads(path.read_bytes())
        receipt['files'] = {name: {key: value[key] for key in ['sha256', 'bytes']}
            for name, value in receipt.get('files', {}).items()}
        receipt['broker_duplicate_caption_artifacts_removed'] = True
        temporary = path.with_name('receipt.broker-cleanup-tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'w') as stream: json.dump(receipt, stream)
            os.replace(temporary, path)
        finally:
            if temporary.exists(): temporary.unlink()


def read_caption_capture(video, maximum, connection, item_id):
    runner = RUNTIME/'tools/transcript-engine/login-diagnostic-oracle.py'
    diagnostic = RUNTIME/'tools/transcript-engine/login-diagnostic.py'
    check_root_file(runner)
    check_root_file(diagnostic)
    previous_runs = set(EVIDENCE.glob('login-caption-broker-*'))
    child = subprocess.Popen(['/usr/bin/python3', '-I', '-B', str(runner),
        '--on-oracle', '--script', str(diagnostic), '--label', 'caption-broker',
        '--mode', 'ytdlp', '--client', 'mweb', '--persistent-session', '--adapter',
        '--pot-server', str(RUNTIME/'provider/server'), '--video', video, '--item-id', item_id],
        env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ, 'stdout')
    selector.register(child.stderr, selectors.EVENT_READ, 'stderr')
    output = bytearray()
    bytes_received = 0
    deadline = time.monotonic() + 115
    try:
        while selector.get_map():
            if STOP_REQUESTED or connection_closed(connection) or time.monotonic() >= deadline:
                cancel_caption(child)
                raise Cancelled()
            for key, _ in selector.select(0.1):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                bytes_received += len(chunk)
                if bytes_received > 65536:
                    cancel_caption(child)
                    raise ValueError('BROKER_CLI_OUTPUT_LIMIT')
                if key.data == 'stdout': output.extend(chunk)
        code = child.wait(timeout=3)
    except Cancelled:
        for directory in set(EVIDENCE.glob('login-caption-broker-*')) - previous_runs:
            cleanup_run(directory/'receipt.json')
        raise
    finally:
        selector.close()
        if child.poll() is None: cancel_caption(child)
        child.stdout.close()
        child.stderr.close()
    try:
        summary = json.loads(output)
        path = Path(summary['receipt'])
        if path.parent.parent != EVIDENCE or path.name != 'receipt.json' \
                or not re.fullmatch(r'login-caption-broker-[0-9a-f]{8}', path.parent.name):
            raise ValueError('BROKER_RECEIPT_PATH_INVALID')
        check_root_file(path)
        if path.stat().st_size > 32 * 1024 * 1024:
            raise ValueError('BROKER_RECEIPT_SIZE_LIMIT')
        receipt = json.loads(path.read_bytes())
    except (KeyError, TypeError, UnicodeError, json.JSONDecodeError):
        return failure('BROKER_CAPTURE_FAILED')
    try:
        return project_capture(receipt, path, code, maximum)
    finally:
        cleanup_run(path)


def project_capture(receipt, path, code, maximum):
    result = receipt.get('result', {})
    if receipt.get('authentication_status') in {'AUTH_REAUTH_REQUIRED', 'REAUTH_REQUIRED'}:
        return failure('AUTH_REAUTH_REQUIRED', 'AUTH_REQUIRED')
    if code != 0 or receipt.get('status') != 'COMPLETED' \
            or receipt.get('resources', {}).get('category') != 'NONE' \
            or receipt.get('resources', {}).get('exit_code') != 0:
        return failure('BROKER_CAPTURE_FAILED')
    if result.get('status') != 'CAPTIONS_RECEIVED':
        if any(row.get('http_status') == 429 for row in result.get('requests', [])):
            return failure('UPSTREAM_RATE_LIMITED', 'RATE_LIMITED')
        statuses = {'PLAYER_REFUSED': ('UNAVAILABLE', 'PLAYER_REFUSED'),
            'NO_ORIGINAL_ENGLISH_JSON3_TRACK': ('NO_CAPTIONS', 'ORIGINAL_TRACK_UNAVAILABLE'),
            'NO_SELECTED_CAPTION_TRACK': ('NO_CAPTIONS', 'ORIGINAL_TRACK_UNAVAILABLE'),
            'SELECTED_CAPTION_PARSE_FAILED': ('PARSE_ERROR', 'CAPTION_PAYLOAD_INVALID'),
            'CAPTION_PARSER_REJECTED': ('PARSE_ERROR', 'CAPTION_PAYLOAD_INVALID'),
            'UNKNOWN_SOURCE_AUTHORITY': ('UNAVAILABLE', 'UNKNOWN_SOURCE_AUTHORITY')}
        if any(row.get('status') == 'LOGIN_REQUIRED' for row in result.get('players', [])):
            return failure('PLAYER_LOGIN_REQUIRED', 'AUTH_REQUIRED')
        status, reason = statuses.get(result.get('status'), ('TEMPORARY_FAILURE', 'UPSTREAM_CAPTION_UNAVAILABLE'))
        return failure(reason, status)
    # yt-dlp may also advertise generated translations despite the skip hint.
    # This bridge supports source captions only; retain original-language
    # provenance while excluding unsupported translation operations.
    tracks = [public_track(value) for value in result['provider_tracks']
        if value.get('track_kind') in {'MANUAL','GENERATED'} and value.get('is_translated') is False]
    selected = public_track(result['provider_selected'])
    if not any(value == selected for value in tracks):
        raise ValueError('TRACK_CONTRACT_INVALID')
    # Read exact bounded artifact files, never the signed URLs or session file.
    capture = {}
    for name in ['caption.raw', 'segments.json']:
        artifact = path.parent/name
        check_root_file(artifact)
        data = artifact.read_bytes()
        if len(data) > (maximum if name == 'caption.raw' else 8 * 1024 * 1024):
            return failure('RESPONSE_SIZE_LIMIT', 'TOO_LARGE')
        expected = receipt.get('files', {}).get(name, {})
        if len(data) != expected.get('bytes') or sha256(data).hexdigest() != expected.get('sha256'):
            raise ValueError('BROKER_CAPTURE_HASH_MISMATCH')
        capture[name] = data
    raw = capture['caption.raw']
    cues = json.loads(capture['segments.json'])
    if not raw or not isinstance(cues, list) or not cues:
        raise ValueError('BROKER_CAPTURE_EMPTY')
    for index, cue in enumerate(cues):
        if not isinstance(cue, dict) or type(cue.get('start_ms')) is not int \
                or type(cue.get('end_ms')) is not int or not 0 <= cue['start_ms'] <= cue['end_ms'] \
                or not isinstance(cue.get('text'), str) or not cue['text'].strip():
            raise ValueError('CAPTION_PAYLOAD_INVALID')
        cues[index] = {'upstream_index': index, 'start_ms': cue['start_ms'],
            'end_ms': cue['end_ms'], 'text': cue['text'], 'speaker_label': cue.get('speaker_label')}
    return {'status': 'OK', 'failure_code': None, 'provider_version': '2026.8.19',
        'python_version': result['python_version'], 'tracks': tracks,
        'video_language': result.get('video_language'), 'selected': selected,
        'segments': cues, 'raw_payload_base64': base64.b64encode(raw).decode('ascii'),
        'raw_payload_hash': sha256(raw).hexdigest(),
        'upstream_requests': len(result.get('requests', [])) + len(result.get('subs_provider', {}).get('requests', [])),
        'bytes_received': len(raw)}


class CaptionBroker:
    def __init__(self, capture=read_caption_capture, clock=time.monotonic):
        self.capture = capture
        self.clock = clock
        self.cached = None

    def execute(self, value, connection):
        value = validate_input(value)
        if self.cached and self.clock() > self.cached['expires']:
            self.cached = None
        if value['operation'] == 'list':
            self.cached = None
            response = self.capture(value['video_id'], value['max_bytes'], connection, value['item_id'])
            if response.get('status') == 'OK':
                self.cached = {'video_id': value['video_id'], 'item_id': value['item_id'], 'expires': self.clock() + 120,
                    'maximum': value['max_bytes'], 'response': response}
            return {**response, 'selected': None, 'segments': [],
                'raw_payload_base64': None, 'raw_payload_hash': None, 'bytes_received': None}
        cached = self.cached
        self.cached = None
        if not cached or cached['video_id'] != value['video_id'] or cached['item_id'] != value['item_id'] \
                or not same_track(cached['response']['selected'], value):
            return failure('SELECTED_TRACK_MISSING', 'UPSTREAM_CHANGED')
        response = cached['response']
        if response['bytes_received'] > value['max_bytes']:
            return failure('RESPONSE_SIZE_LIMIT', 'TOO_LARGE')
        return response


def receive_input(connection):
    body = bytearray()
    connection.settimeout(5)
    while len(body) <= INPUT_LIMIT:
        chunk = connection.recv(min(1024, INPUT_LIMIT + 1 - len(body)))
        if not chunk: break
        body.extend(chunk)
        if b'\n' in chunk: break
    if not body or len(body) > INPUT_LIMIT:
        raise ValueError('INVALID_LOCAL_INPUT')
    return validate_input(json.loads(body))


def serve(path, allowed_uid, group):
    if os.geteuid() != 0 or allowed_uid != 997 or group != 988:
        raise ValueError('BROKER_EXECUTOR_IDENTITY_REQUIRED')
    if not path.is_absolute() or path.resolve() != path or not path.parent.exists():
        raise ValueError('BROKER_SOCKET_DIRECTORY_REQUIRED')
    parent = path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or parent.st_mode & 0o022:
        raise ValueError('BROKER_SOCKET_DIRECTORY_REQUIRED')
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(path))
    os.chown(path, 0, group)
    os.chmod(path, 0o660)
    listener.listen(1)
    listener.settimeout(1)
    broker = CaptionBroker()
    stopping = False
    def stop(*_):
        global STOP_REQUESTED
        nonlocal stopping
        stopping = True
        STOP_REQUESTED = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while not stopping:
            try: connection, _ = listener.accept()
            except socket.timeout: continue
            with connection:
                peer_pid, peer_uid, peer_gid = struct.unpack('3i', connection.getsockopt(
                    socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
                if peer_uid != allowed_uid:
                    continue
                try:
                    value = receive_input(connection)
                    response = broker.execute(value, connection)
                except Cancelled:
                    broker.cached = None
                    continue
                except Exception as error:
                    broker.cached = None
                    response = failure(str(error) if isinstance(error, ValueError) \
                        and re.fullmatch(r'[A-Z_]{1,128}', str(error)) else 'BROKER_LOCAL_FAILURE')
                encoded = (json.dumps(response, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
                if len(encoded) > OUTPUT_LIMIT:
                    broker.cached = None
                    encoded = (json.dumps(failure('RESPONSE_SIZE_LIMIT', 'TOO_LARGE')) + '\n').encode()
                try: connection.sendall(encoded)
                except (ConnectionError, OSError): broker.cached = None
    finally:
        broker.cached = None
        listener.close()
        meta = path.lstat()
        if stat.S_ISSOCK(meta.st_mode) and meta.st_uid == 0:
            path.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--socket', type=Path, required=True)
    parser.add_argument('--uid', type=int, default=997, choices=[997])
    parser.add_argument('--gid', type=int, default=988, choices=[988])
    arguments = parser.parse_args()
    serve(arguments.socket, arguments.uid, arguments.gid)
