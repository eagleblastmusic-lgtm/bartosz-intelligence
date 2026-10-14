"""Offline candidate invariants. No real Snap/process isolation assertions."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
import candidate

HERE=Path(__file__).resolve().parent
C=json.loads((HERE/'candidate.json').read_text())


class Contracts(unittest.TestCase):
    def mutation(self,section,key,value):
        c=deepcopy(C);c[section][key]=value
        with self.assertRaisesRegex(candidate.Rejected,'EXACT_REVIEWED_CANDIDATE_REQUIRED'):candidate.validate(c)
    def test_snap_entrypoint_not_direct_elf(self):self.mutation('runtime','entrypoint','/snap/chromium/current/usr/lib/chromium-browser/chrome')
    def test_no_shared_executor_uid(self):self.mutation('account','name','bartosz-executor')
    def test_no_executor_groups(self):self.mutation('account','supplementary_groups',['bartosz-executor'])
    def test_no_sudo(self):self.mutation('account','sudo',True)
    def test_no_secret_inheritance(self):self.mutation('work','inherit_production_secrets',True)
    def test_no_env_inheritance(self):self.mutation('work','inherit_environment',True)
    def test_no_host_tmp_alias(self):self.mutation('work','profile_parent','/tmp')
    def test_no_resource_raise(self):self.mutation('limits','memory_max_mib',1024)
    def test_no_parallel_browsers(self):self.mutation('work','concurrency',2)
    def test_no_live_promotion(self):self.mutation('network','live_authorized',True)
    def test_no_offline_accepted(self):self.mutation('acceptance','accepted',True)
    def test_uid_requires_new_nonroot_account(self):
        for uid in [0,997,True,65534,None]:
            with self.assertRaisesRegex(candidate.Rejected,'NEW_DEDICATED_UID_REQUIRED'):candidate.render(C,uid)
    def test_slice_and_service_share_limits_without_autostart(self):
        files=candidate.render(C,60000);service=files['bartosz-browser-local-trial.service'];slice_text=files['user-60000.slice']
        self.assertIn('Slice=user-60000.slice',service)
        for text in files.values():
            self.assertIn('MemoryMax=768M',text);self.assertIn('CPUQuota=50%',text);self.assertIn('TasksMax=256',text)
            self.assertNotIn('[Install]',text)
        self.assertIn('PrivateNetwork=yes',service);self.assertIn('Restart=no',service)
        for incompatible in ['NoNewPrivileges','CapabilityBoundingSet','RestrictNamespaces','PrivateUsers','PrivateDevices','SystemCallFilter','EnvironmentFile']:
            self.assertNotIn(incompatible,service)
    def test_apply_no_force_before_reading_or_mutation(self):
        p=subprocess.run([sys.executable,'-B',str(HERE/'candidate.py'),'apply'],capture_output=True,timeout=5)
        self.assertEqual(p.returncode,78);self.assertEqual(json.loads(p.stdout)['code'],'INSTALLATION_NOT_AUTHORIZED_OR_IMPLEMENTED')
    def test_local_trial_default_executes_nothing(self):
        spec=importlib.util.spec_from_file_location('trial',HERE/'run-local-trial.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        with patch.object(subprocess,'run',side_effect=AssertionError('NO_EXECUTION_AUTHORIZED')):value=m.plan()
        self.assertFalse(value['executes']);self.assertFalse(value['accepted']);self.assertNotIn('--no-sandbox',value['command'])
    def test_existing_v2_blocker_preserved(self):
        sys.path.insert(0,str(HERE.parent));import install,policy
        self.assertEqual(install.deployment_blockers(policy.load(HERE.parent/'runtime.json')),['DIRECT_ELF_LIBRARY_BOUNDARY_UNENFORCED'])


if __name__=='__main__':
    result=unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(Contracts))
    receipt={'schema':'ote-isolation-architecture-contracts:1','tests':result.testsRun,'pass':result.wasSuccessful(),
        'platform':sys.platform,'active_browser_tested':False,'accepted':False}
    if len(sys.argv)>1:Path(sys.argv[1]).write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt));sys.exit(0 if result.wasSuccessful()else 2)
