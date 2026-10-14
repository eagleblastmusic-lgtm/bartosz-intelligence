"""Bounded, standalone process-tree supervisor; stdlib, Windows and Linux ARM64.

Windows uses a kill-on-close memory-limited Job Object. Linux defaults to an RSS
watchdog; --memory-cgroup requires a kernel hard boundary and makes RSS diagnostic.
No services, package installs, production environment or database access.
"""
from __future__ import annotations

import argparse
import ctypes
from hashlib import sha256
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time


if os.name == 'nt':
    from ctypes import wintypes as w

    class Entry(ctypes.Structure):
        _fields_ = [('size', w.DWORD), ('usage', w.DWORD), ('pid', w.DWORD),
                    ('heap', ctypes.c_size_t), ('module', w.DWORD), ('threads', w.DWORD),
                    ('ppid', w.DWORD), ('priority', w.LONG), ('flags', w.DWORD), ('exe', w.WCHAR * 260)]

    class Memory(ctypes.Structure):
        _fields_ = [('size', w.DWORD), ('faults', w.DWORD)] + [(n, ctypes.c_size_t) for n in
            ('peak_rss', 'rss', 'peak_paged', 'paged', 'peak_nonpaged', 'nonpaged', 'pagefile', 'peak_pagefile', 'private')]

    class BasicLimit(ctypes.Structure):
        _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64), ('flags', w.DWORD),
                    ('min_ws', ctypes.c_size_t), ('max_ws', ctypes.c_size_t), ('active', w.DWORD),
                    ('affinity', ctypes.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]

    class IO(ctypes.Structure):
        _fields_ = [(n, ctypes.c_uint64) for n in ('read_ops', 'write_ops', 'other_ops', 'read', 'write', 'other')]

    class ExtendedLimit(ctypes.Structure):
        _fields_ = [('basic', BasicLimit), ('io', IO), ('process_memory', ctypes.c_size_t),
                    ('job_memory', ctypes.c_size_t), ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]

    class Accounting(ctypes.Structure):
        _fields_ = [(n, ctypes.c_int64) for n in ('user', 'kernel', 'period_user', 'period_kernel')] + [
            (n, w.DWORD) for n in ('faults', 'total_processes', 'active_processes', 'terminated_processes')]

    class CompletionPort(ctypes.Structure):
        _fields_ = [('key', ctypes.c_void_p), ('port', w.HANDLE)]

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    psapi = ctypes.WinDLL('psapi', use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = w.HANDLE
    kernel.Process32FirstW.argtypes = kernel.Process32NextW.argtypes = [w.HANDLE, ctypes.POINTER(Entry)]
    kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
    kernel.OpenProcess.restype = w.HANDLE
    kernel.CloseHandle.argtypes = [w.HANDLE]
    psapi.GetProcessMemoryInfo.argtypes = [w.HANDLE, ctypes.POINTER(Memory), w.DWORD]
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
    kernel.CreateJobObjectW.restype = w.HANDLE
    kernel.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
    kernel.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p]
    kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
    kernel.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
    kernel.CreateIoCompletionPort.argtypes = [w.HANDLE, w.HANDLE, ctypes.c_size_t, w.DWORD]
    kernel.CreateIoCompletionPort.restype = w.HANDLE
    kernel.GetQueuedCompletionStatus.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD),
        ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_void_p), w.DWORD]


def processes():
    """Return pid -> (ppid, RSS, private bytes, cumulative CPU seconds). No names."""
    rows = {}
    if os.name == 'nt':
        handle = kernel.CreateToolhelp32Snapshot(2, 0)
        entry = Entry()
        entry.size = ctypes.sizeof(entry)
        valid = kernel.Process32FirstW(handle, ctypes.byref(entry))
        while valid:
            rss = private = 0
            proc_handle = kernel.OpenProcess(0x410, False, entry.pid)
            if proc_handle:
                memory = Memory()
                memory.size = ctypes.sizeof(memory)
                if psapi.GetProcessMemoryInfo(proc_handle, ctypes.byref(memory), ctypes.sizeof(memory)):
                    rss, private = memory.rss, memory.private
                kernel.CloseHandle(proc_handle)
            rows[int(entry.pid)] = (int(entry.ppid), int(rss), int(private), 0)
            valid = kernel.Process32NextW(handle, ctypes.byref(entry))
        kernel.CloseHandle(handle)
    else:
        tick = os.sysconf('SC_CLK_TCK')
        page = os.sysconf('SC_PAGE_SIZE')
        for path in Path('/proc').iterdir():
            if not path.name.isdigit():
                continue
            try:
                tail = (path / 'stat').read_text().rsplit(')', 1)[1].split()
                rows[int(path.name)] = (int(tail[1]), int(tail[21]) * page, 0,
                                        (int(tail[11]) + int(tail[12])) / tick)
            except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError, IndexError):
                continue
    return rows


def descendants(rows, root):
    selected = {root}
    while True:
        expanded = selected | {pid for pid, row in rows.items() if row[0] in selected}
        if expanded == selected:
            return selected
        selected = expanded


def memory_boundary(path, limit):
    """Read-only, fail-closed check of a root-controlled cgroup ancestor."""
    base = Path('/sys/fs/cgroup')
    if os.name == 'nt' or not path.is_absolute() or path == base or path.resolve() != path or not path.is_relative_to(base):
        raise ValueError('INVALID_MEMORY_CGROUP')
    for entry in [path, path / 'memory.max', path / 'memory.swap.max']:
        mode = entry.stat()
        if mode.st_uid != 0 or mode.st_mode & 0o022:
            raise ValueError('UNTRUSTED_MEMORY_CGROUP')
    relative = '/' + path.relative_to(base).as_posix()
    own = next((line[3:] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::')), '')
    if not (own == relative or own.startswith(relative + '/')):
        raise ValueError('SUPERVISOR_OUTSIDE_MEMORY_CGROUP')
    if (path / 'memory.max').read_text().strip() != str(limit) or (path / 'memory.swap.max').read_text().strip() != '0':
        raise ValueError('MEMORY_CGROUP_LIMIT_MISMATCH')
    return {name: (path / name).read_text().strip() for name in
            ('memory.current', 'memory.peak', 'memory.max', 'memory.swap.max', 'memory.events')}


def oom_count(boundary):
    return sum(int(value) for key, value in (line.split() for line in boundary['memory.events'].splitlines())
               if key in {'oom_kill', 'oom_group_kill'})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--memory-mib', type=int, default=768)
    parser.add_argument('--memory-cgroup', type=Path)
    parser.add_argument('--timeout', type=float, default=60)
    parser.add_argument('--cancel-file', type=Path)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or not 32 <= args.memory_mib <= 1536 or not 0.1 <= args.timeout <= 120:
        raise SystemExit('INVALID_SUPERVISOR_INPUT')
    job = port = None
    limit = args.memory_mib * 1024 * 1024
    boundary_before = None
    if args.memory_cgroup:
        try:
            boundary_before = memory_boundary(args.memory_cgroup, limit)
        except (ValueError, OSError) as error:
            raise SystemExit('MEMORY_CGROUP_REQUIRED:' + str(error))
    if os.name != 'nt':
        # Reparent orphaned descendants here on timeout/disconnect, not to systemd.
        if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
            raise SystemExit('SUBREAPER_REQUIRED')
    child_env = {key: value for key, value in os.environ.items() if key.upper() in {
        'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'LD_LIBRARY_PATH',
        'PYTHONNOUSERSITE', 'PYTHONDONTWRITEBYTECODE'}}
    child_env['BARTOSZ_OTE_SUPERVISED'] = '1'
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=child_env,
        stdin=subprocess.DEVNULL, start_new_session=os.name != 'nt',
        creationflags=(subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP) if os.name == 'nt' else 0)
    if os.name == 'nt':
        job = kernel.CreateJobObjectW(None, None)
        info = ExtendedLimit()
        info.basic.flags = 0x2000 | 0x200  # KILL_ON_JOB_CLOSE | JOB_MEMORY
        info.job_memory = limit
        if not job or not kernel.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)) or not kernel.AssignProcessToJobObject(job, w.HANDLE(process._handle)):
            process.kill()
            if job:
                kernel.CloseHandle(job)
            raise SystemExit('MEMORY_JOB_SETUP_FAILED')
        port = kernel.CreateIoCompletionPort(w.HANDLE(-1), None, 0, 1)
        association = CompletionPort(None, port)
        if not port or not kernel.SetInformationJobObject(job, 7, ctypes.byref(association), ctypes.sizeof(association)):
            kernel.TerminateJobObject(job, 90)
            kernel.CloseHandle(job)
            raise SystemExit('MEMORY_JOB_NOTIFICATIONS_REQUIRED')
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    counts = {'stdout': 0, 'stderr': 0}
    flags = {'output_limit': False, 'cancelled': False}

    def drain(name, stream):
        while True:
            chunk = stream.read(65536)
            if not chunk:
                return
            counts[name] += len(chunk)
            if counts[name] > 2 * 1024 * 1024:
                flags['output_limit'] = True
            else:
                output[name].extend(chunk)

    threads = [threading.Thread(target=drain, args=(name, getattr(process, name)), daemon=True)
               for name in ('stdout', 'stderr')]
    for thread in threads:
        thread.start()
    signal.signal(signal.SIGINT, lambda *_: flags.update(cancelled=True))
    signal.signal(signal.SIGTERM, lambda *_: flags.update(cancelled=True))
    start = time.monotonic()
    peak_rss = peak_private = 0
    known = {process.pid}
    cpu_seen = {}
    category = 'NONE'
    samples = 0

    def memory_notification():
        if not port:
            return False
        message, key, pointer = w.DWORD(), ctypes.c_size_t(), ctypes.c_void_p()
        hit = False
        while kernel.GetQueuedCompletionStatus(port, ctypes.byref(message), ctypes.byref(key), ctypes.byref(pointer), 0):
            hit |= message.value in {9, 10}
        return hit

    while process.poll() is None:
        rows = processes()
        tree = descendants(rows, process.pid) | (known & rows.keys())
        known |= tree
        samples += 1
        peak_rss = max(peak_rss, sum(rows[p][1] for p in tree if p in rows))
        peak_private = max(peak_private, sum(rows[p][2] for p in tree if p in rows))
        for pid in tree:
            if pid in rows:
                cpu_seen[pid] = max(cpu_seen.get(pid, 0), rows[pid][3])
        if flags['cancelled'] or (args.cancel_file is not None and args.cancel_file.is_file()):
            category = 'CANCELLED'
        elif flags['output_limit']:
            category = 'OUTPUT_LIMIT'
        elif time.monotonic() - start >= args.timeout:
            category = 'TIMEOUT'
        elif args.memory_cgroup:
            try:
                if oom_count(memory_boundary(args.memory_cgroup, limit)) > oom_count(boundary_before):
                    category = 'MEMORY_LIMIT'
            except (ValueError, OSError):
                category = 'MEMORY_BOUNDARY_LOST'
        elif peak_rss > limit or memory_notification():
            category = 'MEMORY_LIMIT'
        if category != 'NONE':
            break
        time.sleep(0.05)
    if category != 'NONE':
        if job:
            kernel.TerminateJobObject(job, 90)
        else:
            for _ in range(3):
                rows = processes()
                targets = descendants(rows, os.getpid()) - {os.getpid()} | (known & rows.keys())
                for pid in sorted(targets, reverse=True):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                time.sleep(0.03)
    process.wait(timeout=5)
    if category == 'NONE' and memory_notification():
        category = 'MEMORY_LIMIT'
    boundary_after = None
    if args.memory_cgroup:
        try:
            boundary_after = memory_boundary(args.memory_cgroup, limit)
            if oom_count(boundary_after) > oom_count(boundary_before):
                category = 'MEMORY_LIMIT'
        except (ValueError, OSError):
            category = 'MEMORY_BOUNDARY_LOST'
    for thread in threads:
        thread.join(timeout=2)
    job_cpu = job_peak = None
    if job:
        accounting = Accounting()
        info = ExtendedLimit()
        if kernel.QueryInformationJobObject(job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None):
            job_cpu = (accounting.user + accounting.kernel) / 10000
        if kernel.QueryInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info), None):
            job_peak = info.peak_job
        kernel.CloseHandle(job)
        kernel.CloseHandle(port)
    if os.name != 'nt':
        while True:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0:
                    break
            except ChildProcessError:
                break
    rows = processes()
    remaining = (descendants(rows, os.getpid()) - {os.getpid()}) | (known & rows.keys())
    remaining.discard(process.pid)
    if remaining and os.name != 'nt':
        for pid in remaining:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        category = 'ORPHAN_CLEANUP'
        time.sleep(0.05)
        # Reap the subreaper's own children before checking residual processes.
        while True:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0:
                    break
            except ChildProcessError:
                break
        remaining &= processes().keys()
    stdout = bytes(output['stdout'])
    try:
        child_result = json.loads(stdout)
    except (ValueError, UnicodeError):
        child_result = None
    receipt = {'schema': 'ote-supervisor:1', 'platform': sys.platform,
        'category': category, 'exit_code': process.returncode,
        'elapsed_ms': round((time.monotonic() - start) * 1000),
        'peak_tree_rss_bytes': peak_rss, 'peak_tree_private_bytes': peak_private if job else None,
        'peak_job_commit_bytes': job_peak, 'tree_cpu_ms': job_cpu if job else round(sum(cpu_seen.values()) * 1000, 3),
        'cpu_measurement': 'WINDOWS_JOB_ACCOUNTING' if job else 'PROC_TREE_SAMPLED_LOWER_BOUND',
        'memory_limit_bytes': limit,
        'memory_enforcement': 'LINUX_CGROUP_V2_KERNEL_HARD_RSS_DIAGNOSTIC' if args.memory_cgroup else
            'WINDOWS_JOB_COMMIT_HARD_AND_RSS_WATCHDOG' if job else 'LINUX_AGGREGATE_RSS_50MS_WATCHDOG',
        'memory_cgroup': str(args.memory_cgroup) if args.memory_cgroup else None,
        'cgroup_before': boundary_before, 'cgroup_after': boundary_after,
        'samples': samples, 'descendants_remaining': len(remaining),
        'stdout_bytes': counts['stdout'], 'stderr_bytes': counts['stderr'],
        'stdout_sha256': sha256(stdout).hexdigest(),
        'stderr_sha256': sha256(output['stderr']).hexdigest(), 'child_result': child_result}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: receipt[key] for key in ('schema', 'category', 'exit_code', 'elapsed_ms', 'peak_tree_rss_bytes', 'tree_cpu_ms', 'descendants_remaining')}))
    return 0 if category == 'NONE' and process.returncode == 0 and not remaining else 2


if __name__ == '__main__':
    sys.exit(main())
