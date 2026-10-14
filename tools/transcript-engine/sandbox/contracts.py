"""Offline security contracts. Fixtures prove rejection logic, never a sandbox."""
from copy import deepcopy
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch
import zipfile

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import policy
import prepare
import install
import positive

C=policy.load(HERE/'runtime.json')
ASSETS=policy.load(HERE/'assets.json')
ARGS=policy.FIXED_ARGS[:-1]+['--user-data-dir=/tmp/bartosz-ote-profile-abc123','about:blank']


class Contracts(unittest.TestCase):
    def reject(self,code,fn,*args,**kwargs):
        with self.assertRaisesRegex(policy.Rejected,'^'+code+'$'):fn(*args,**kwargs)
    def test_exact_configuration(self):
        self.assertEqual(policy.validate_config(deepcopy(C)),C)
    def test_configuration_cannot_redirect_executable(self):
        c={**C,'executable':'/tmp/chrome'}
        self.reject('CONFIG_EXECUTABLE',policy.validate_config,c)
    def test_configuration_cannot_disable_sandbox(self):
        self.reject('CONFIG_SANDBOX_REQUIRED',policy.validate_config,{**C,'sandbox_required':False})
    def test_configuration_rejects_unknown_fields(self):
        self.reject('UNKNOWN_CONFIG_FIELD',policy.validate_config,{**C,'extra_args':['--no-sandbox']})
    def test_profile_matches_only_pinned_path(self):
        policy.validate_profile(C,(HERE/(C['apparmor_profile_name']+'.apparmor')).read_text())
    def test_profile_wildcard_rejected(self):
        text=policy.profile_text(C).replace(C['executable'],'/**/chrome-headless-shell')
        self.reject('PROFILE_CONTENT_MISMATCH',policy.validate_profile,C,text)
    def test_profile_additional_rule_rejected(self):
        text=policy.profile_text(C).replace('  userns,','  userns,\n  capability,')
        self.reject('PROFILE_CONTENT_MISMATCH',policy.validate_profile,C,text)
    def test_profile_wrong_version_rejected(self):
        text=policy.profile_text(C).replace('153.0.8010.12','152.0.0.0')
        self.reject('PROFILE_CONTENT_MISMATCH',policy.validate_profile,C,text)
    def test_root_metadata_accepted(self):
        policy.check_meta(self.meta(),gid=C['gid'],mode=0o750)
    def meta(self,**changes):
        return dict({'uid':0,'gid':C['gid'],'mode':0o750,'regular':True,'directory':False,'symlink':False},**changes)
    def test_nonroot_owner_rejected(self):
        self.reject('ROOT_OWNERSHIP_REQUIRED',policy.check_meta,self.meta(uid=997))
    def test_writable_runtime_rejected(self):
        self.reject('WRITABLE_BY_NONROOT',policy.check_meta,self.meta(mode=0o770))
    def test_symlink_rejected_before_following(self):
        self.reject('SYMLINK_FORBIDDEN',policy.check_meta,self.meta(symlink=True))
    def test_suid_runtime_rejected(self):
        self.reject('SPECIAL_MODE_FORBIDDEN',policy.check_meta,self.meta(mode=0o4750))
    def test_world_executable_runtime_rejected(self):
        self.reject('MODE_MISMATCH',policy.check_meta,self.meta(mode=0o755),gid=C['gid'],mode=0o750)
    def test_wrong_group_rejected(self):
        self.reject('GROUP_MISMATCH',policy.check_meta,self.meta(gid=1001),gid=C['gid'])
    def test_managed_assets_contract(self):
        self.assertEqual(len(policy.validate_assets(C,ASSETS)),287)
    def test_asset_traversal_rejected(self):
        a=deepcopy(ASSETS);a['files']['../inject.so']=next(iter(a['files'].values()))
        self.reject('ASSET_PATH_INVALID',policy.validate_assets,C,a)
    def test_asset_control_collision_rejected(self):
        a=deepcopy(ASSETS);a['files']['launcher.py']=next(iter(a['files'].values()))
        self.reject('CONTROL_NAME_COLLISION',policy.validate_assets,C,a)
    def test_asset_hash_identity_rejected(self):
        a=deepcopy(ASSETS);a['files']['chrome-headless-shell']['sha256']='0'*64
        self.reject('EXECUTABLE_HASH_MISMATCH',policy.validate_assets,C,a)
    def test_archive_hash_rejected(self):
        self.reject('ARCHIVE_HASH_MISMATCH',prepare.inspect_archive,C,b'not the pinned browser')
    def test_zip_traversal_rejected_after_valid_hash(self):
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,'w') as z:z.writestr('chrome-headless-shell-linux-arm64/../inject',b'x')
        blob=stream.getvalue();c={**C,'archive_sha256':sha256(blob).hexdigest()}
        self.reject('ZIP_PATH',prepare.inspect_archive,c,blob)
    def test_exact_cdp_arguments_accepted(self):
        self.assertEqual(str(policy.validate_args(C,ARGS,997)),ARGS[-2].split('=',1)[1])
    def test_sandbox_bypass_arguments_rejected(self):
        for bypass in ['--no-sandbox','--disable-namespace-sandbox','--disable-seccomp-filter-sandbox',
                       '--disable-setuid-sandbox','--single-process','--remote-debugging-port=9222']:
            with self.subTest(bypass=bypass):
                self.reject('UNAPPROVED_BROWSER_ARGUMENT',policy.validate_args,C,ARGS+[bypass],997)
    def test_root_browser_rejected(self):
        self.reject('EXECUTION_ACCOUNT_REQUIRED',policy.validate_args,C,ARGS,0)
    def test_profile_escape_rejected(self):
        args=[x.replace('/tmp/bartosz-ote-profile-abc123','/tmp/../root/bartosz-ote-profile-abc123')for x in ARGS]
        self.reject('PRIVATE_PROFILE_PATH',policy.validate_args,C,args,997)
    def test_profile_must_be_fresh_and_private(self):
        from unittest.mock import Mock
        profile=Mock();profile.iterdir.return_value=iter(['Cookie'])
        m=self.meta(uid=997,mode=0o700,regular=False,directory=True)
        with patch.object(policy,'Path',return_value=profile),patch.object(os,'geteuid',return_value=997,create=True),patch.object(policy,'validate_args',return_value=profile),patch.object(policy,'metadata',return_value=m):
            self.reject('PROFILE_NOT_FRESH',policy.private_profile,C,ARGS)
        m['mode']=0o755
        with patch.object(policy,'Path',return_value=profile),patch.object(os,'geteuid',return_value=997,create=True),patch.object(policy,'validate_args',return_value=profile),patch.object(policy,'metadata',return_value=m):
            self.reject('PRIVATE_PROFILE_PERMISSIONS',policy.private_profile,C,ARGS)
    def test_dynamic_loader_environment_not_forwarded(self):
        with patch.dict(os.environ,{'LD_LIBRARY_PATH':'/tmp/inject','LD_PRELOAD':'/tmp/inject.so','PYTHONPATH':'/tmp/inject'}):
            self.assertEqual(set(policy.clean_environment(Path('/tmp/private'))),{'PATH','LANG','HOME','TMPDIR'})
    def proof(self):
        browser={'Uid':'997 997 997 997','Gid':'988 988 988 988','apparmor':C['apparmor_profile_name']+' (unconfined)',
            'namespaces':{'user':'user:[1]','pid':'pid:[2]','net':'net:[3]'}}
        renderer={**deepcopy(browser),'Seccomp':'2','Seccomp_filters':'1','NoNewPrivs':'1','CapEff':'0','CapAmb':'0',
            'NSpid':'123 3','namespaces':{'user':'user:[4]','pid':'pid:[5]','net':'net:[6]'}}
        return browser,renderer
    def test_kernel_proof_predicate_fixture_only(self):
        positive.sandbox_assertions(C,*self.proof())
    def test_proof_cannot_pass_from_flags_only(self):
        b,r=self.proof();r['Seccomp']='0'
        self.reject('RENDERER_SECCOMP_INACTIVE',positive.sandbox_assertions,C,b,r)
    def test_proof_rejects_shared_namespaces(self):
        for ns in ['user','pid','net']:
            b,r=self.proof();r['namespaces'][ns]=b['namespaces'][ns]
            self.reject('RENDERER_NAMESPACE_SHARED_'+ns.upper(),positive.sandbox_assertions,C,b,r)
    def test_proof_rejects_wrong_apparmor_profile(self):
        b,r=self.proof();r['apparmor']='unconfined'
        self.reject('PROFILE_NOT_ATTACHED',positive.sandbox_assertions,C,b,r)
    def test_proof_rejects_privileged_renderer(self):
        b,r=self.proof();r['CapEff']='200000'
        self.reject('RENDERER_CAPABILITIES_PRESENT',positive.sandbox_assertions,C,b,r)
    def test_proof_rejects_root_renderer(self):
        b,r=self.proof();r['Uid']='0 0 0 0'
        self.reject('BROWSER_UID_NOT_DEDICATED',positive.sandbox_assertions,C,b,r)
    def test_proof_requires_no_new_privileges(self):
        b,r=self.proof();r['NoNewPrivs']='0'
        self.reject('RENDERER_NNP_INACTIVE',positive.sandbox_assertions,C,b,r)
    def test_plan_does_not_load_policy_or_start_processes(self):
        with patch.object(subprocess,'run',side_effect=AssertionError('MUTATION')):
            p=install.plan(C,ASSETS)
        self.assertTrue(p['owner_approval_required']);self.assertFalse(p['changes_sysctl']);self.assertFalse(p['changes_services'])
    def test_known_library_bypass_blocks_apply_before_any_host_write(self):
        with patch.object(install,'trusted_packet'),patch.object(policy,'account_matches',side_effect=AssertionError('MUTATION_PHASE_REACHED')),patch.object(install,'parser_operation',side_effect=AssertionError('POLICY_LOAD_REACHED')):
            self.reject('DIRECT_ELF_LIBRARY_BOUNDARY_UNENFORCED',install.apply,C,ASSETS,Path('/unused.zip'),'unused')
    def test_plan_discloses_critical_library_boundary(self):
        p=install.plan(C,ASSETS)
        self.assertFalse(p['deployment_allowed']);self.assertEqual(p['critical_blockers'],['DIRECT_ELF_LIBRARY_BOUNDARY_UNENFORCED'])
    def test_administrative_actions_refuse_nonroot(self):
        with patch.object(os,'name','posix'),patch.object(os,'geteuid',return_value=997,create=True):
            with self.assertRaisesRegex(RuntimeError,'^ROOT_ISOLATED_ADMIN_REQUIRED$'):install.trusted_packet()
    def test_launcher_refuses_unmanaged_location(self):
        result=subprocess.run([sys.executable,'-I',str(HERE/'launcher.py'),'--validate-only'],capture_output=True,timeout=5)
        self.assertEqual(result.returncode,78)
        self.assertEqual(json.loads(result.stderr)['code'],'MANAGED_PATH_REQUIRED')
    def test_rollback_cannot_ignore_process_permission_denial(self):
        process=Path('/proc/123')
        with patch.object(install.Path,'iterdir',return_value=iter([process])),patch.object(os,'readlink',side_effect=PermissionError(13,'denied')):
            with self.assertRaisesRegex(RuntimeError,'^PROCESS_VISIBILITY_REQUIRED$'):install.browsers(C['executable'])
    def test_cdp_fetch_before_navigation_response(self):
        """Real pipes + deferred response reproduce the navigation deadlock risk."""
        inbound,write=os.pipe();read,outbound=os.pipe();errors=[]
        def peer():
            buf=b'';nav=None
            try:
                while True:
                    data=os.read(inbound,65536)
                    if not data:return
                    buf+=data
                    while b'\0' in buf:
                        raw,buf=buf.split(b'\0',1);m=json.loads(raw)
                        if m['method']=='Page.navigate':
                            nav=m['id']
                            msg={'method':'Fetch.requestPaused','sessionId':'s','params':{'requestId':'r','request':{'url':'http://127.0.0.1:12345/'}}}
                            os.write(outbound,json.dumps(msg).encode()+b'\0')
                        else:
                            os.write(outbound,json.dumps({'id':m['id'],'result':{}}).encode()+b'\0')
                            if nav is not None:
                                os.write(outbound,json.dumps({'id':nav,'result':{'frameId':'f'}}).encode()+b'\0');nav=None
            except (OSError,ValueError) as e:errors.append(type(e).__name__)
        worker=threading.Thread(target=peer,daemon=True);worker.start()
        cdp=positive.CDP(write,read);state={'external_requests_blocked':0}
        guard=positive.RequestGuard(cdp,'s','http://127.0.0.1:12345',state)
        try:
            self.assertEqual(cdp.call('Page.navigate',{'url':'http://127.0.0.1:12345/'},'s'),{'frameId':'f'})
            guard.check();self.assertEqual(state['external_requests_blocked'],0)
        finally:
            guard.close();os.close(write);worker.join(timeout=2)
            os.close(outbound);cdp.thread.join(timeout=2);os.close(inbound);os.close(read)
        self.assertFalse(errors)
    def test_guard_blocks_external_origin(self):
        from queue import Queue
        from unittest.mock import Mock
        cdp=Mock();cdp.events=Queue();state={'external_requests_blocked':0}
        guard=positive.RequestGuard(cdp,'s','http://127.0.0.1:12345',state)
        cdp.events.put({'method':'Fetch.requestPaused','sessionId':'s','params':{'requestId':'x','request':{'url':'https://www.youtube.com/'}}})
        deadline=time.monotonic()+1
        while not cdp.call.called and time.monotonic()<deadline:time.sleep(0.01)
        guard.close();guard.check()
        cdp.call.assert_called_once_with('Fetch.failRequest',{'requestId':'x','errorReason':'Aborted'},'s')
        self.assertEqual(state['external_requests_blocked'],1)


class Results(unittest.TextTestResult):
    def __init__(self,*args,**kwargs):super().__init__(*args,**kwargs);self.cases=[]
    def addSuccess(self,test):super().addSuccess(test);self.cases.append({'test':test.id().split('.')[-1],'status':'PASS'})
    def addError(self,test,err):super().addError(test,err);self.cases.append({'test':test.id().split('.')[-1],'status':'ERROR'})
    def addFailure(self,test,err):super().addFailure(test,err);self.cases.append({'test':test.id().split('.')[-1],'status':'FAIL'})


if __name__=='__main__':
    started=time.monotonic()
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(Contracts)
    result=unittest.TextTestRunner(resultclass=Results,verbosity=1).run(suite)
    receipt={'schema':'ote-sandbox-contracts:1','platform':platform.system(),'machine':platform.machine(),
        'tests':result.testsRun,'pass':result.wasSuccessful(),'cases':result.cases,'elapsed_ms':round((time.monotonic()-started)*1000),
        'host_security_changes':0,'browser_executions':0,'sandbox_active':'NOT_TESTED','accepted':False}
    if len(sys.argv)>1:Path(sys.argv[1]).write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(receipt));raise SystemExit(0 if result.wasSuccessful() else 2)
