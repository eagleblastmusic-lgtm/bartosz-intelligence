#!/usr/bin/env python3
"""Validate and render a local isolation candidate. Never install or start it."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
CONFIG = HERE / 'candidate.json'


class Rejected(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise Rejected(code)


def load_candidate():
    return json.loads(CONFIG.read_text(encoding='utf-8'))


def validate(c):
    """This is one reviewable revision, not a user-extensible launcher policy."""
    require(isinstance(c, dict), 'CONFIG_OBJECT_REQUIRED')
    expected_keys = {'schema', 'architecture', 'accepted', 'state', 'runtime',
                     'account', 'launch', 'resources', 'network', 'acceptance', 'host_changes'}
    require(set(c) == expected_keys, 'CONFIG_KEYS')
    require(c['schema'] == 'ote-browser-isolation-candidate:1', 'CONFIG_SCHEMA')
    require(c['architecture'] == 'A_PLUS_MINIMAL_C', 'ARCHITECTURE')
    require(c['accepted'] is False and c['state'] == 'UNINSTALLED_ACTIVE_ACCEPTANCE_REQUIRED',
            'STATIC_SUCCESS_FORBIDDEN')
    runtime = c['runtime']
    require(isinstance(runtime, dict) and set(runtime) == {
        'type', 'command', 'snap', 'channel', 'revision', 'version', 'base', 'architecture',
        'confinement', 'publisher_id', 'publisher_validation', 'download_bytes',
        'download_sha3_384', 'store_response_sha256', 'installed_assertion_verified',
        'snap_confine_repair'}, 'RUNTIME_KEYS')
    require((runtime['type'], runtime['command'], runtime['snap'], runtime['channel']) ==
            ('canonical-chromium-snap', '/snap/bin/chromium', 'chromium', 'latest/stable'),
            'MANAGED_SNAP_ENTRY_POINT_REQUIRED')
    require(type(runtime['revision']) is int and runtime['revision'] == 3555 and
            runtime['version'] == '155.0.8059.39' and runtime['base'] == 'core24',
            'REVISION_REVIEW_REQUIRED')
    require((runtime['architecture'], runtime['confinement'], runtime['publisher_id'],
             runtime['publisher_validation']) == ('arm64', 'strict', 'canonical', 'verified'),
            'STORE_OR_CONFINEMENT_MISMATCH')
    require(runtime['download_bytes'] == 195907584 and
            runtime['download_sha3_384'] == '0e947935cbea615ad1f48ec9b67996212c8297f73e0bad499909e1ff3ae643c5379e72109ddbe1554e0c066ee770e0d0' and
            runtime['store_response_sha256'] == '8f3aff152c4091a0b86c11836c386cfd3e6a12bd5b82d8250b43d7be6281affb',
            'STORE_METADATA_PIN_MISMATCH')
    require(runtime['installed_assertion_verified'] is False and
            runtime['snap_confine_repair'] == 'FORBIDDEN_NO_SUID_OR_CAPABILITY_CHANGES',
            'NO_INSTALL_PROOF_OR_HELPER_REPAIR')
    account = c['account']
    require(account == {
        'user': 'bartosz-browser', 'group': 'bartosz-browser', 'home': '/home/bartosz-browser',
        'shell': '/usr/sbin/nologin', 'supplementary_groups': [], 'executor_uid_excluded': 997,
        'sudo': False, 'login': False, 'secrets': False}, 'ACCOUNT_SEPARATION_REQUIRED')
    launch = c['launch']
    require(set(launch) == {'worker', 'worker_owner', 'job_root', 'environment', 'inherit_environment',
                           'fd_allowlist', 'transport', 'arbitrary_command_or_argv', 'initial_url',
                           'required_flags', 'forbidden_flags', 'ipc'}, 'LAUNCH_KEYS')
    job_root = '/home/bartosz-browser/snap/chromium/common/jobs'
    require((launch['worker'], launch['worker_owner'], launch['job_root']) ==
            ('/opt/bartosz-intelligence/browser-trial/run-local-trial.py', 'root', job_root),
            'ROOT_MANAGED_WORKER_AND_PRIVATE_SCRATCH_REQUIRED')
    require(launch['environment'] == {'PATH': '/usr/bin:/bin', 'HOME': '/home/bartosz-browser',
            'LANG': 'C.UTF-8', 'TMPDIR': job_root} and launch['inherit_environment'] is False,
            'CLEAN_ENVIRONMENT_REQUIRED')
    require(launch['fd_allowlist'] == [0, 1, 2, 3, 4] and
            launch['transport'] == 'CDP_PIPE_FD3_FD4', 'CDP_FD_CONTRACT')
    require(launch['arbitrary_command_or_argv'] is False and launch['initial_url'] == 'about:blank' and
            launch['required_flags'] == ['--headless=new', '--remote-debugging-pipe'] and
            launch['forbidden_flags'] == ['--no-sandbox', '--disable-setuid-sandbox',
            '--disable-namespace-sandbox', '--disable-seccomp-filter-sandbox', '--single-process',
            '--renderer-cmd-prefix'] and
            launch['ipc'] == 'BOUNDED_TRIAL_INPUT_OUTPUT_NO_PRODUCTION_SECRETS',
            'FIXED_SANDBOXED_LOCAL_TRIAL_CONTRACT')
    require(c['resources'] == {'memory_high_mib': 640, 'memory_max_mib': 768,
            'memory_swap_max_bytes': 0, 'cpu_quota_percent': 50, 'tasks_max': 256,
            'timeout_seconds': 100, 'stop_timeout_seconds': 10, 'concurrency': 1,
            'common_parent': 'user-BROWSER_UID.slice', 'cgroup_movement_proof': 'NOT_RUN',
            'cleanup_scope': 'ENTIRE_DEDICATED_UID_SLICE_NOT_OUTER_SERVICE_ONLY'},
            'BOUNDED_COMMON_UID_CGROUP_REQUIRED')
    require(c['network'] == {'mode': 'LOCAL_HARNESS_ONLY', 'private_network': True,
            'harness_location': 'SAME_TRIAL_UNIT_NETWORK_NAMESPACE',
            'host_namespace_rejoin': 'MUST_BE_REJECTED_BY_ACTIVE_ACCEPTANCE', 'proof': 'NOT_RUN',
            'live_source_access': 'BLOCKED_AUTHORIZATION'}, 'PRIVATE_LOCAL_NETWORK_REQUIRED')
    require(c['acceptance'] == {name: 'NOT_RUN' for name in (
            'chromium_started', 'cdp_pipe', 'snap_apparmor_enforce', 'renderer_namespaces_seccomp',
            'browser_no_host_capabilities', 'filesystem_and_secret_boundary',
            'effective_cgroup_limits', 'cancellation_and_cleanup')} |
            {'native_sandbox': 'NOT_PROVEN_BY_STATIC_CONFIGURATION'}, 'ACTIVE_PROOF_REQUIRED')
    require(c['host_changes'] == {name: False for name in (
            'performed', 'sysctl', 'custom_apparmor', 'v2_installer_unblocked', 'snapd_install',
            'production_executor', 'd1', 'youtube')}, 'HOST_MUTATION_OR_SCOPE_EXPANSION')
    return {'candidate_contract': 'PASS', 'accepted': False,
            'native_sandbox': 'NOT_PROVEN_BY_STATIC_CONFIGURATION',
            'BROWSER_ISOLATION_ARCHITECTURE': 'SELECTED_A_PLUS_MINIMAL_C_PENDING_ACTIVE_ACCEPTANCE'}


def validate_uid(uid):
    require(type(uid) is int and 100 <= uid < 64512 and uid not in (997, 1000),
            'DEDICATED_NONROOT_UID_REQUIRED')
    return uid


def template_values(text):
    """Parse strict review templates: no shell, continuation, duplicates or extra directives."""
    rows, section = {}, None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('['):
            require(re.fullmatch(r'\[(Unit|Service|Slice)\]', line) is not None, 'UNIT_SECTION')
            section = line[1:-1]
            continue
        require(section is not None and '=' in line and not line.endswith('\\'), 'UNIT_SYNTAX')
        key, value = line.split('=', 1)
        require((section, key) not in rows, 'UNIT_DUPLICATE_DIRECTIVE')
        rows[(section, key)] = value
    return rows


def validate_templates(c, service, slice_text):
    validate(c)
    s, g = template_values(service), template_values(slice_text)
    resource_values = {'MemoryAccounting': 'yes', 'MemoryHigh': '640M', 'MemoryMax': '768M',
                       'MemorySwapMax': '0', 'CPUAccounting': 'yes', 'CPUQuota': '50%',
                       'TasksAccounting': 'yes', 'TasksMax': '256'}
    expected_s = {('Unit', 'Description'): 'Bartosz OTE local Chromium Snap isolation trial'}
    expected_s |= {('Service', key): value for key, value in resource_values.items()}
    expected_s |= {('Service', key): value for key, value in {
        'Type': 'exec', 'User': 'bartosz-browser', 'Group': 'bartosz-browser',
        'SupplementaryGroups': '', 'Slice': 'user-@BROWSER_UID@.slice',
        'WorkingDirectory': '/home/bartosz-browser', 'UMask': '0077',
        'ExecStart': '/usr/bin/env -i PATH=/usr/bin:/bin HOME=/home/bartosz-browser LANG=C.UTF-8 TMPDIR=/home/bartosz-browser/snap/chromium/common/jobs /usr/bin/python3 -I /opt/bartosz-intelligence/browser-trial/run-local-trial.py',
        'PrivateNetwork': 'yes', 'RuntimeMaxSec': '100s', 'TimeoutStopSec': '10s',
        'KillMode': 'control-group', 'Restart': 'no', 'StandardInput': 'null',
        'StandardOutput': 'journal', 'StandardError': 'journal'}.items()}
    expected_g = {('Unit', 'Description'): 'Dedicated Bartosz browser UID resource boundary'}
    expected_g |= {('Slice', key): value for key, value in resource_values.items()}
    require(s == expected_s and g == expected_g, 'TEMPLATE_EXPANSION_OR_CONFIG_MISMATCH')
    return {'template_contract': 'PASS', 'installed': False, 'started': False}


def render(c, uid, service=None, slice_text=None):
    uid = validate_uid(uid)
    service = (HERE / 'trial.service.in').read_text(encoding='utf-8') if service is None else service
    slice_text = ((HERE / 'user-BROWSER_UID.slice.in').read_text(encoding='utf-8')
                  if slice_text is None else slice_text)
    validate_templates(c, service, slice_text)
    service = service.replace('@BROWSER_UID@', str(uid)).replace('\r\n', '\n')
    slice_text = slice_text.replace('\r\n', '\n')
    require('@BROWSER_UID@' not in service, 'UNRENDERED_UID')
    return {'bartosz-browser-local-trial.service': service,
            f'user-{uid}.slice': slice_text}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('action', choices=['validate', 'render', 'plan', 'apply'])
    ap.add_argument('--config', type=Path, default=CONFIG)
    ap.add_argument('--uid', type=int)
    ap.add_argument('--output', type=Path)
    args = ap.parse_args(argv)
    if args.action == 'apply':
        # Refuse before reading arbitrary paths or constructing subprocess calls.
        print(json.dumps({'status': 'BLOCKED_OWNER_APPROVAL_AND_ACTIVE_ACCEPTANCE',
                          'accepted': False, 'host_changes': 0}))
        return 78
    c = json.loads(args.config.read_text(encoding='utf-8'))
    result = validate(c)
    templates = render(c, args.uid) if args.uid is not None else None
    if args.action == 'render':
        require(templates is not None and args.output is not None, 'LOCAL_RENDER_UID_OUTPUT_REQUIRED')
        args.output.mkdir(parents=True, exist_ok=True)
        for name, contents in templates.items():
            with (args.output / name).open('x', encoding='utf-8', newline='\n') as handle:
                handle.write(contents)
        result |= {'rendered_files': list(templates), 'uid_is_fixture_or_unverified_input': True}
    else:
        validate_templates(c, (HERE / 'trial.service.in').read_text(encoding='utf-8'),
                           (HERE / 'user-BROWSER_UID.slice.in').read_text(encoding='utf-8'))
    if args.action == 'plan':
        result |= {'operation': 'REVIEW_ONLY_NO_INSTALL_PATH', 'v2_installer': 'REMAINS_BLOCKED',
                   'config_sha256': hashlib.sha256(args.config.read_bytes()).hexdigest(),
                   'required_owner_operations': ['create dedicated browser account/home',
                       'snap install one asserted Chromium revision and declared dependencies',
                       'inspect generated AppArmor/seccomp and interface connections',
                       'install reviewed root-owned trial worker and unit/slice',
                       'start local trial once without enable/autostart',
                       'prove sandbox/private-network/cgroups/cleanup or rollback'],
                   'scope': 'LOCAL_OFFLINE_TRIAL_ONLY_NO_PRODUCTION_OR_YOUTUBE'}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (Rejected, OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({'status': 'REJECTED', 'reason': str(exc), 'accepted': False}))
        sys.exit(78)
