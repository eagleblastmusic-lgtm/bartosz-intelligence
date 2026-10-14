#!/usr/bin/env python3
"""Offline negative contracts for the selected, uninstalled architecture."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('ote_candidate', HERE / 'validate-candidate.py')
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class Contracts(unittest.TestCase):
    def setUp(self):
        self.c = candidate.load_candidate()

    def bad(self, section, key, value):
        self.c[section][key] = value
        with self.assertRaises(candidate.Rejected):
            candidate.validate(self.c)

    def test_selected_reviewable_candidate_never_claims_active_pass(self):
        result = candidate.validate(self.c)
        self.assertFalse(result['accepted'])
        self.assertEqual(result['native_sandbox'], 'NOT_PROVEN_BY_STATIC_CONFIGURATION')

    def test_account_cannot_reuse_executor_or_have_shared_groups(self):
        self.bad('account', 'user', 'bartosz-executor')
        self.c = candidate.load_candidate()
        self.bad('account', 'supplementary_groups', ['bartosz-executor'])

    def test_root_executor_ubuntu_nobody_and_noninteger_uid_rejected(self):
        for uid in (0, 99, 997, 1000, 64512, 65534, True, '60000'):
            with self.subTest(uid=uid), self.assertRaises(candidate.Rejected):
                candidate.render(self.c, uid)

    def test_render_preserves_common_uid_parent_and_memory_bound(self):
        rendered = candidate.render(self.c, 60000)
        service = candidate.template_values(rendered['bartosz-browser-local-trial.service'])
        slice_values = candidate.template_values(rendered['user-60000.slice'])
        self.assertEqual(service[('Service', 'Slice')], 'user-60000.slice')
        self.assertEqual(service[('Service', 'MemoryMax')], '768M')
        self.assertEqual(slice_values[('Slice', 'MemoryMax')], '768M')
        self.assertEqual(service[('Service', 'PrivateNetwork')], 'yes')

    def test_revision_and_architecture_mismatch_needs_new_review(self):
        self.bad('runtime', 'revision', 3554)
        self.c = candidate.load_candidate()
        self.bad('runtime', 'architecture', 'amd64')

    def test_classic_unsigned_or_wrong_publisher_rejected(self):
        for key, value in (('confinement', 'classic'), ('publisher_id', 'other'),
                           ('publisher_validation', 'unproven'), ('download_sha3_384', '0' * 96)):
            self.c = candidate.load_candidate()
            self.bad('runtime', key, value)

    def test_direct_elf_bypassing_snap_entry_point_rejected(self):
        self.bad('runtime', 'command', '/snap/chromium/3555/usr/lib/chromium-browser/chrome')

    def test_library_injection_or_inherited_secrets_rejected(self):
        for name in ('LD_PRELOAD', 'LD_LIBRARY_PATH', 'CLOUDFLARE_API_TOKEN', 'PYTHONPATH'):
            self.c = candidate.load_candidate()
            self.c['launch']['environment'][name] = '/tmp/hostile'
            with self.subTest(name=name), self.assertRaises(candidate.Rejected):
                candidate.validate(self.c)

    def test_memory_increase_concurrency_and_service_only_cleanup_rejected(self):
        for key, value in (('memory_max_mib', 769), ('concurrency', 2),
                           ('cleanup_scope', 'OUTER_SERVICE_ONLY'), ('timeout_seconds', 0)):
            self.c = candidate.load_candidate()
            self.bad('resources', key, value)

    def test_sandbox_disabling_flags_extra_fds_and_live_url_rejected(self):
        for key, value in (('required_flags', ['--headless=new', '--no-sandbox']),
                           ('fd_allowlist', [0, 1, 2, 3, 4, 8]),
                           ('initial_url', 'https://www.youtube.com/')):
            self.c = candidate.load_candidate()
            self.bad('launch', key, value)

    def test_native_proof_cannot_be_promoted_from_offline(self):
        self.bad('acceptance', 'renderer_namespaces_seccomp', 'PASS')
        self.c = candidate.load_candidate()
        self.bad('network', 'proof', 'PASS')
        self.c = candidate.load_candidate()
        self.c['accepted'] = True
        with self.assertRaises(candidate.Rejected):
            candidate.validate(self.c)

    def test_template_privilege_or_autostart_expansion_rejected(self):
        service = (HERE / 'trial.service.in').read_text(encoding='utf-8')
        slice_text = (HERE / 'user-BROWSER_UID.slice.in').read_text(encoding='utf-8')
        for extra in ('NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'PrivateUsers=yes',
                      'PrivateDevices=yes', 'RestrictNamespaces=yes', 'EnvironmentFile=/tmp/env',
                      'ExecStart=/bin/sh -c hostile', '[Install]\nWantedBy=multi-user.target'):
            with self.subTest(extra=extra), self.assertRaises(candidate.Rejected):
                candidate.validate_templates(self.c, service + '\n' + extra + '\n', slice_text)

    def test_apply_refuses_before_config_reads_or_subprocess(self):
        with patch.object(Path, 'read_text', side_effect=AssertionError('apply read arbitrary file')):
            with patch.object(subprocess, 'run', side_effect=AssertionError('apply started process')):
                self.assertEqual(candidate.main(['apply', '--config', '/etc/shadow']), 78)

    def test_host_security_mutation_or_v2_unlock_rejected(self):
        self.bad('host_changes', 'v2_installer_unblocked', True)
        self.c = candidate.load_candidate()
        self.bad('host_changes', 'sysctl', True)


def main():
    started = time.monotonic()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(Contracts)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    receipt = {'schema': 'ote-browser-isolation-offline-contracts:1', 'platform': sys.platform,
               'python': sys.version.split()[0], 'tests': result.testsRun,
               'failures': len(result.failures), 'errors': len(result.errors),
               'elapsed_ms': round((time.monotonic() - started) * 1000),
               'status': 'PASS' if result.wasSuccessful() else 'FAIL',
               'browser_launches': 0, 'host_changes': 0, 'accepted': False,
               'active_policy_evidence': 'NOT_RUN'}
    if len(sys.argv) > 1:
        output = Path(sys.argv[1])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(receipt))
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main())
