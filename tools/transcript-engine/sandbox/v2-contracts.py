"""Offline v2 invariants; no claim that a compiled profile was enforced."""
from copy import deepcopy
from contextlib import ExitStack, contextmanager
import errno
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4
import enforced
import policy

HERE=Path(__file__).resolve().parent
C=policy.load(HERE/'enforced-runtime.json');LOCK=enforced.load_lock(HERE/'v2-library-lock.json')
TEXT=(HERE/(enforced.PROFILE+'.apparmor')).read_text()


def module(name,filename):
    spec=importlib.util.spec_from_file_location(name,HERE/filename);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m


@contextmanager
def rollback_fixture_directory():
    if os.name!='nt':
        with tempfile.TemporaryDirectory(prefix='ote-v2-rollback-contract-')as directory:yield Path(directory)
        return
    # Python 3.14 mkdir(0700) uses a Windows DACL inaccessible to the sandbox
    # token. Synthetic fixture data may inherit workspace ACLs with mkdir(0755).
    name='ote-v2-rollback-contract-'+uuid4().hex
    directory=HERE/name;directory.mkdir(mode=0o755)
    try:yield directory
    finally:
        if directory.is_symlink()or directory.name!=name or directory.resolve().parent!=HERE.resolve():
            raise AssertionError('ROLLBACK_FIXTURE_CLEANUP_BOUNDARY')
        shutil.rmtree(directory)


class Contracts(unittest.TestCase):
    def reject(self,code,fn,*args):
        with self.assertRaisesRegex(policy.Rejected,'^'+code+'$'):fn(*args)
    def test_config_exact(self):enforced.validate_config(C)
    def test_wrong_elf_path(self):self.reject('V2_EXACT_TARGET',enforced.validate_config,{**C,'launcher':'/tmp/chrome'})
    def test_unapproved_direct_elf_path(self):self.reject('CONFIG_EXECUTABLE',enforced.validate_config,{**C,'executable':'/tmp/chrome'})
    def test_profile_exact_contract(self):
        result=enforced.validate_profile(C,LOCK,TEXT);self.assertEqual(result['exact_m_paths'],60);self.assertEqual(result['exact_exec_paths'],1)
    def test_unconfined_mode_rejected(self):self.reject('V2_PROFILE_EXACT_CONTRACT',enforced.validate_profile,C,LOCK,TEXT.replace('enforce','unconfined'))
    def test_broad_m_rule_rejected(self):self.reject('V2_PROFILE_EXACT_CONTRACT',enforced.validate_profile,C,LOCK,TEXT.replace('  userns,','  userns,\n  /** mrwx,'))
    def test_tmp_mapping_rule_rejected(self):self.reject('V2_PROFILE_EXACT_CONTRACT',enforced.validate_profile,C,LOCK,TEXT.replace('  userns,','  userns,\n  /tmp/** mr,'))
    def test_shell_child_exec_rejected(self):self.reject('V2_PROFILE_EXACT_CONTRACT',enforced.validate_profile,C,LOCK,TEXT.replace('  userns,','  userns,\n  /bin/sh ix,'))
    def test_outgoing_profile_grant_rejected(self):self.reject('V2_PROFILE_EXACT_CONTRACT',enforced.validate_profile,C,LOCK,TEXT.replace('deny change_profile','change_profile'))
    def test_abstraction_m_grants_rejected(self):self.reject('V2_PROFILE_EXACT_CONTRACT',enforced.validate_profile,C,LOCK,TEXT.replace('  userns,','  include <abstractions/base>\n  userns,'))
    def test_new_loader_mapping_requires_manifest(self):
        self.reject('V2_PROFILE_EXACT_CONTRACT',enforced.validate_profile,C,LOCK,TEXT.replace('  userns,','  userns,\n  /usr/lib/aarch64-linux-gnu/unobserved.so mr,'))
    def row(self):return deepcopy(next(r for r in LOCK['files'].values()if r['kind']=='system'))
    def test_bad_library_owner(self):
        row=self.row();row['uid']=997;self.reject('V2_ROOT_OWNER',enforced.check_metadata,row)
    def test_group_write_library(self):
        row=self.row();row['mode']=0o664;self.reject('V2_NONROOT_WRITE',enforced.check_metadata,row)
    def test_world_write_parent(self):
        row=self.row();row.update(type='directory',mode=0o777);self.reject('V2_NONROOT_WRITE',enforced.check_metadata,row)
    def test_extended_acl_write_or_unknown(self):
        row=self.row();row['acl']=True;self.reject('V2_EXTENDED_ACL_FORBIDDEN',enforced.check_metadata,row)
    def test_file_capabilities(self):
        row=self.row();row['file_capabilities']=True;self.reject('V2_FILE_CAPABILITIES_FORBIDDEN',enforced.check_metadata,row)
    def test_hardlink_alias(self):
        row=self.row();row['nlink']=2;self.reject('V2_HARDLINK_FORBIDDEN',enforced.check_metadata,row)
    def test_user_owned_symlink(self):
        row=self.row();row.update(uid=997,type='symlink',mode=0o777);self.reject('V2_ROOT_OWNER',enforced.check_metadata,row)
    def test_root_owned_symlink_mode_is_not_write_acl(self):
        row=self.row();row.update(type='symlink',mode=0o777);enforced.check_metadata(row)
    def test_glob_mapping_path_rejected(self):self.reject('V2_LITERAL_PATH',enforced.exact_path,'/usr/lib/aarch64-linux-gnu/*.so','system')
    def test_variable_mapping_path_rejected(self):self.reject('V2_LITERAL_PATH',enforced.exact_path,'/@{HOME}/lib.so','system')
    def test_newline_mapping_path_rejected(self):self.reject('V2_LITERAL_PATH',enforced.exact_path,'/usr/lib/aarch64-linux-gnu/libx.so\n/** mrwx,','system')
    def test_traversal_mapping_path_rejected(self):self.reject('V2_LITERAL_PATH',enforced.exact_path,'/usr/lib/aarch64-linux-gnu/../libx.so','system')
    def test_tmp_mapping_location_rejected(self):self.reject('V2_SYSTEM_MAPPING_PATH',enforced.exact_path,'/tmp/lib.so','system')
    def test_unapproved_runtime_code_location(self):self.reject('V2_RUNTIME_MAPPING_PATH',enforced.exact_path,enforced.ROOT+'/user/library.so','runtime')
    def test_lock_cannot_claim_dynamic_coverage(self):
        lock=deepcopy(LOCK);lock['dynamic_observation']='PASS';self.reject('V2_LATE_LOAD_CLAIM',enforced.validate_lock,lock)
    def test_bad_lock_hash(self):
        lock=deepcopy(LOCK);next(iter(lock['files'].values()))['sha256']='wrong';self.reject('V2_MAPPING_HASH_SIZE',enforced.validate_lock,lock)
    def system_library(self):
        return next((path,deepcopy(row))for path,row in LOCK['files'].items()if row['kind']=='system')
    def test_valid_format_library_hash_still_checks_actual_bytes(self):
        path,row=self.system_library()
        fields=('uid','gid','mode','nlink','type','acl','file_capabilities','target')
        actual={key:row[key]for key in fields}
        mismatched='0'*64 if row['sha256']!='0'*64 else '1'*64
        self.assertRegex(mismatched,'^[a-f0-9]{64}$')
        with patch.object(enforced,'chain',return_value={'resolved':path}),patch.object(enforced,'metadata',return_value=actual),patch.object(enforced,'Path')as filesystem,patch.object(enforced,'digest',return_value=mismatched):
            filesystem.return_value.stat.return_value.st_size=row['bytes']
            self.reject('V2_LIBRARY_BYTES_CHANGED',enforced.validate_system,LOCK)
    def library_chain_metadata(self,path,row,change):
        fields=('uid','gid','mode','nlink','type','acl','file_capabilities','target')
        def observed(entry):
            actual={key:row[key]for key in fields}
            if str(entry)==path:actual.update(change)
            else:actual.update(type='directory',mode=0o755,target=None)
            return actual
        return observed
    def test_system_validation_rejects_observed_library_owner(self):
        path,row=self.system_library()
        with patch.object(enforced,'Path',PurePosixPath),patch.object(enforced,'metadata',side_effect=self.library_chain_metadata(path,row,{'uid':997})):
            self.reject('V2_ROOT_OWNER',enforced.validate_system,LOCK)
    def test_system_validation_rejects_observed_library_write_mode(self):
        path,row=self.system_library()
        with patch.object(enforced,'Path',PurePosixPath),patch.object(enforced,'metadata',side_effect=self.library_chain_metadata(path,row,{'mode':0o666})):
            self.reject('V2_NONROOT_WRITE',enforced.validate_system,LOCK)
    def test_exact_executable_mapping_required(self):
        lock=deepcopy(LOCK);del lock['files'][C['executable']];self.reject('V2_EXECUTABLE_MAPPING_MISSING',enforced.validate_lock,lock)
    def test_elf_parser_invalid_bytes(self):self.reject('ARM64_ELF_REQUIRED',enforced.elf_info,b'not an ELF')
    def test_parent_component_tamper_detected(self):
        path='/usr/lib/aarch64-linux-gnu/libx.so';row=self.row()
        def get(p):
            return {**row,'type':'directory','mode':0o777}if str(p)=='/usr'else{**row,'type':'directory'if str(p)!=path else'file','mode':0o755}
        with patch.object(enforced,'Path',PurePosixPath),patch.object(enforced,'metadata',side_effect=get):self.reject('V2_NONROOT_WRITE',enforced.chain,path)
    def test_launcher_no_sandbox_arguments_rejected(self):
        args=policy.FIXED_ARGS[:-1]+['--user-data-dir=/tmp/bartosz-ote-profile-abc123','about:blank','--no-sandbox']
        self.reject('UNAPPROVED_BROWSER_ARGUMENT',policy.validate_args,C,args,997)
    def test_launcher_v2_wrong_location_refuses(self):
        p=subprocess.run([sys.executable,'-I',str(HERE/'launcher-v2.py'),'--validate-only'],capture_output=True,timeout=5)
        self.assertEqual(p.returncode,78);self.assertEqual(json.loads(p.stderr)['code'],'V2_MANAGED_PATH_REQUIRED')
    def test_active_harness_default_runs_no_process(self):
        harness=module('active','v2-active-tests.py')
        with patch.object(subprocess,'run',side_effect=AssertionError('UNAUTHORIZED_SUBPROCESS')),patch.object(subprocess,'Popen',side_effect=AssertionError('UNAUTHORIZED_PROCESS')):
            r=harness.blocked(HERE/'enforced-runtime.json',HERE/'v2-library-lock.json')
        self.assertFalse(r['accepted']);self.assertEqual(r['subprocess_executions'],0)
    def inspect_fixture_model(self,changes=None,after_changes=None,open_error=None,data=b'controlled fixture',limit=65536):
        harness=module('fixture_inspection','v2-active-tests.py')
        def record(mode,uid,gid,inode,size=0):
            return {'st_mode':mode,'st_uid':uid,'st_gid':gid,'st_ino':inode,'st_dev':8,'st_nlink':1,
                'st_size':size,'st_mtime_ns':10,'st_ctime_ns':20}
        anchor=SimpleNamespace(**record(stat.S_IFDIR|0o1777,0,0,10))
        directory=SimpleNamespace(**record(stat.S_IFDIR|0o700,997,988,20))
        before=record(stat.S_IFREG|0o600,997,988,30,len(data));before.update(changes or {})
        after={**before,**(after_changes or {})}
        opens=[3,4,5]
        if open_error is not None:opens[open_error]=OSError(errno.ELOOP,'controlled symlink rejection')
        with ExitStack()as mocks:
            mocks.enter_context(patch.object(harness,'Path',PurePosixPath))
            for name,value in [('O_NOFOLLOW',0x100000),('O_DIRECTORY',0x200000),('O_CLOEXEC',0x400000),('O_NONBLOCK',0x800000)]:
                mocks.enter_context(patch.object(harness.os,name,value,create=True))
            opened=mocks.enter_context(patch.object(harness.os,'open',side_effect=opens))
            mocks.enter_context(patch.object(harness.os,'fstat',side_effect=[anchor,directory,SimpleNamespace(**before),SimpleNamespace(**after)]))
            mocks.enter_context(patch.object(harness.os,'read',side_effect=[data,b'']))
            closed=mocks.enter_context(patch.object(harness.os,'close'))
            for operation in ['write','chmod','chown','unlink','fchmod','fchown']:
                mocks.enter_context(patch.object(harness.os,operation,side_effect=AssertionError('ROOT_FIXTURE_OBSERVER_MUST_ONLY_READ'),create=True))
            result=harness.inspect_uid_fixture('/tmp/bartosz-ote-profile-model/libfixture.so',limit=limit)
            self.assertEqual([call.args[0]for call in opened.call_args_list],['/tmp','bartosz-ote-profile-model','libfixture.so'])
            for call in opened.call_args_list:
                self.assertTrue(call.args[1]&harness.os.O_NOFOLLOW)
                self.assertFalse(call.args[1]&(os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC))
            self.assertTrue(opened.call_args_list[2].args[1]&harness.os.O_NONBLOCK)
            self.assertEqual(opened.call_args_list[1].kwargs['dir_fd'],3)
            self.assertEqual(opened.call_args_list[2].kwargs['dir_fd'],4)
            self.assertEqual(sorted(call.args[0]for call in closed.call_args_list),[3,4,5])
            return result
    def test_root_fixture_observer_reads_only_nofollow_pinned_fds(self):
        data=b'controlled fixture';result=self.inspect_fixture_model(data=data)
        self.assertEqual(result['data'],data);self.assertEqual(result['sha256'],sha256(data).hexdigest())
        self.assertEqual((result['uid'],result['gid'],result['mode'],result['bytes']),(997,988,0o600,len(data)))
    def test_root_fixture_observer_rejects_file_symlink(self):
        with self.assertRaisesRegex(RuntimeError,'^FIXTURE_NOFOLLOW_OPEN_FAILED$'):self.inspect_fixture_model(open_error=2)
    def test_root_fixture_observer_rejects_directory_symlink(self):
        with self.assertRaisesRegex(RuntimeError,'^FIXTURE_NOFOLLOW_OPEN_FAILED$'):self.inspect_fixture_model(open_error=1)
    def test_root_fixture_observer_rejects_fifo_before_read(self):
        with self.assertRaisesRegex(RuntimeError,'^FIXTURE_FILE_METADATA$'):self.inspect_fixture_model(changes={'st_mode':stat.S_IFIFO|0o600})
    def test_root_fixture_observer_rejects_unsafe_file_metadata(self):
        for changes in [{'st_uid':0},{'st_gid':0},{'st_nlink':2},{'st_mode':stat.S_IFREG|0o666},{'st_mode':stat.S_IFREG|0o4600}]:
            with self.subTest(changes=changes),self.assertRaisesRegex(RuntimeError,'^FIXTURE_FILE_METADATA$'):
                self.inspect_fixture_model(changes=changes)
    def test_root_fixture_observer_enforces_size_before_and_during_read(self):
        for changes in [{'st_size':5},{'st_size':3}]:
            with self.subTest(changes=changes),self.assertRaisesRegex(RuntimeError,'^FIXTURE_SIZE_LIMIT$'):
                self.inspect_fixture_model(changes=changes,data=b'12345',limit=4)
    def test_root_fixture_observer_rejects_inode_or_ctime_change_during_read(self):
        for changes in [{'st_ino':31},{'st_ctime_ns':21}]:
            with self.subTest(changes=changes),self.assertRaisesRegex(RuntimeError,'^FIXTURE_CHANGED_DURING_READ$'):
                self.inspect_fixture_model(after_changes=changes)
    def test_root_fixture_observer_rejects_declared_read_size_mismatch(self):
        with self.assertRaisesRegex(RuntimeError,'^FIXTURE_READ_SIZE_CHANGED$'):
            self.inspect_fixture_model(changes={'st_size':100},data=b'short')
    def result_writer_model(self,parent_changes=None,existing=False):
        harness=module('root_result_writer','v2-active-tests.py')
        class ResultPath(PurePosixPath):
            def absolute(self):return self
            def lstat(self):
                meta={'st_mode':stat.S_IFDIR|0o755,'st_uid':0}
                if str(self)=='/root/ote-v2':meta.update(parent_changes or {})
                return SimpleNamespace(**meta)
        result={'accepted':False,'evidence':'controlled fixture'}
        with ExitStack()as mocks:
            mocks.enter_context(patch.object(harness,'Path',ResultPath))
            mocks.enter_context(patch.object(harness.os,'name','posix'))
            mocks.enter_context(patch.object(harness.os,'geteuid',return_value=0,create=True))
            for name,value in [('O_NOFOLLOW',0x100000),('O_DIRECTORY',0x200000),('O_CLOEXEC',0x400000)]:
                mocks.enter_context(patch.object(harness.os,name,value,create=True))
            opened=mocks.enter_context(patch.object(harness.os,'open',side_effect=[10,FileExistsError('existing receipt')]if existing else[10,11]))
            stream=mocks.enter_context(patch.object(harness.os,'fdopen'))
            closed=mocks.enter_context(patch.object(harness.os,'close'))
            try:harness.write_result('/root/ote-v2/receipt.json',result)
            except Exception:
                if parent_changes:
                    opened.assert_not_called();stream.assert_not_called();closed.assert_not_called()
                elif existing:
                    stream.assert_not_called();closed.assert_called_once_with(10)
                raise
            self.assertEqual(len(opened.call_args_list),2)
            self.assertTrue(opened.call_args_list[0].args[1]&harness.os.O_DIRECTORY)
            self.assertTrue(opened.call_args_list[0].args[1]&harness.os.O_NOFOLLOW)
            selected=opened.call_args_list[1]
            self.assertEqual(selected.args[0],'receipt.json');self.assertEqual(selected.args[2],0o600)
            self.assertEqual(selected.kwargs,{'dir_fd':10})
            for flag in [os.O_WRONLY,os.O_CREAT,os.O_EXCL,harness.os.O_NOFOLLOW]:self.assertTrue(selected.args[1]&flag)
            self.assertFalse(selected.args[1]&os.O_TRUNC)
            stream.assert_called_once_with(11,'wb')
            stream.return_value.__enter__.return_value.write.assert_called_once_with((json.dumps(result,indent=2)+'\n').encode())
            closed.assert_called_once_with(10)
    def test_root_result_rejects_account_owned_or_writable_parent_before_open(self):
        for changes in [{'st_uid':997},{'st_mode':stat.S_IFDIR|0o777}]:
            with self.subTest(changes=changes),self.assertRaisesRegex(RuntimeError,'^OBSERVER_RESULT_PARENT_NOT_TRUSTED$'):
                self.result_writer_model(parent_changes=changes)
    def test_root_result_rejects_symlink_parent_before_open(self):
        with self.assertRaisesRegex(RuntimeError,'^OBSERVER_RESULT_PARENT_NOT_TRUSTED$'):
            self.result_writer_model(parent_changes={'st_mode':stat.S_IFLNK|0o777})
    def test_root_result_requires_fresh_nofollow_file_and_exact_receipt_bytes(self):
        self.result_writer_model()
        with self.assertRaises(FileExistsError):self.result_writer_model(existing=True)
    def isolation_fixture(self):
        namespaces={'user':'user:[1]','pid':'pid:[2]','net':'net:[3]'}
        browser={key:'0000000000000000'for key in ['CapEff','CapAmb','CapPrm','CapInh']}
        browser['namespaces']=deepcopy(namespaces)
        renderer=deepcopy(browser);renderer.update(uid_map='997 997 1',gid_map='988 988 1')
        return browser,renderer,{'namespaces':namespaces}
    def test_isolation_complete_fixture(self):
        harness=module('isolation_positive','v2-active-tests.py')
        harness.isolation_evidence(C,*self.isolation_fixture())
    def test_isolation_nonzero_permitted_capabilities_rejected(self):
        harness=module('isolation_caps','v2-active-tests.py')
        for process in [0,1]:
            with self.subTest(process='browser'if process==0 else'renderer'):
                evidence=list(self.isolation_fixture());evidence[process]['CapPrm']='0000000000000001'
                with self.assertRaisesRegex(harness.Rejected,'^HOST_CAPABILITIES_PRESENT$'):
                    harness.isolation_evidence(C,*evidence)
    def test_isolation_missing_namespace_maps_rejected(self):
        harness=module('isolation_map','v2-active-tests.py')
        for field,code in [('uid_map','UNEXPECTED_RENDERER_UID_MAP'),('gid_map','UNEXPECTED_RENDERER_GID_MAP')]:
            for missing in [False,True]:
                with self.subTest(field=field,missing=missing):
                    browser,renderer,observer=self.isolation_fixture()
                    if missing:del renderer[field]
                    else:renderer[field]=''
                    with self.assertRaisesRegex(harness.Rejected,'^'+code+'$'):
                        harness.isolation_evidence(C,browser,renderer,observer)
    def test_isolation_browser_outside_observer_host_namespaces_rejected(self):
        harness=module('isolation_host','v2-active-tests.py')
        browser,renderer,observer=self.isolation_fixture();browser['namespaces']['user']='user:[99]'
        with self.assertRaisesRegex(harness.Rejected,'^BROWSER_NOT_IN_OBSERVED_HOST_NAMESPACES$'):
            harness.isolation_evidence(C,browser,renderer,observer)
    def test_rollback_targets_accepts_sealed_runtime_without_asset_validation(self):
        root=MagicMock();root.__str__.return_value=C['runtime_root']
        profile=MagicMock();profile.__str__.return_value=C['apparmor_profile_path'];profile.exists.return_value=True
        profile.parent.__str__.return_value='/etc/apparmor.d'
        paths={C['runtime_root']:root,C['apparmor_profile_path']:profile}
        baseline={'uid':0,'gid':988,'mode':0o700,'nlink':1,'type':'directory','acl':False,'file_capabilities':False,'target':None}
        def observed(path):
            return baseline if str(path)==C['runtime_root']else{**baseline,'gid':0,'mode':0o644,'type':'file'}
        with patch.object(enforced,'Path',side_effect=lambda path:paths[str(path)]),patch.object(enforced,'chain',side_effect=lambda path:{'resolved':str(path)}),patch.object(enforced,'metadata',side_effect=observed),patch.object(enforced,'digest',return_value='0'*64),patch.object(enforced,'validate_runtime',side_effect=AssertionError('ROLLBACK_MUST_NOT_REQUIRE_HEALTHY_RUNTIME'))as runtime_check,patch.object(policy,'validate_assets',side_effect=AssertionError('ROLLBACK_MUST_NOT_REQUIRE_HEALTHY_ASSETS'))as assets_check,patch.object(policy,'load',side_effect=AssertionError('ROLLBACK_MUST_NOT_READ_ASSETS')):
            result=enforced.rollback_targets(C)
        self.assertTrue(result['profile_file_present']);self.assertEqual(result['original_profile_sha256'],'0'*64)
        runtime_check.assert_not_called();assets_check.assert_not_called()
    def test_audit_trace_is_not_mapping_denial(self):
        harness=module('audit','v2-active-tests.py')
        self.assertFalse(harness.matching_mmap_denials([{'apparmor':'DENIED','operation':'open','pid':'1','profile':enforced.PROFILE,'name':'/tmp/x','requested_mask':'m','denied_mask':'m'}],1,enforced.PROFILE,'/tmp/x'))
    def test_audit_wrong_pid_does_not_pass(self):
        harness=module('audit2','v2-active-tests.py')
        event={'apparmor':'DENIED','operation':'file_mmap','pid':'2','profile':enforced.PROFILE,'name':'/tmp/x','requested_mask':'m','denied_mask':'m'}
        self.assertFalse(harness.matching_mmap_denials([event],1,enforced.PROFILE,'/tmp/x'))
    def test_v2_plan_has_no_force(self):
        m=module('candidate_plan','v2-plan.py');r,_,_=m.plan()
        self.assertFalse(r['deployment_allowed']);self.assertIn('UNCONFINED_INCOMING_PROFILE_TRANSITION_NOT_CLOSED',r['critical_blockers'])
    def test_v2_apply_cli_rejected_even_with_current_approved_hash(self):
        m=module('candidate_apply_plan','v2-plan.py');proposal,_,_=m.plan()
        for approval in [[],['--approved-plan-sha256',proposal['plan_sha256']]]:
            with self.subTest(approved_hash=bool(approval)):
                result=subprocess.run([sys.executable,'-B',str(HERE/'v2-plan.py'),'apply',*approval],capture_output=True,timeout=5)
                self.assertEqual(result.returncode,78)
                receipt=json.loads(result.stdout)
                self.assertEqual(receipt['code'],'V2_INSTALLATION_BLOCKED_NO_FORCE_PATH')
                self.assertEqual(receipt['status'],'REFUSED');self.assertFalse(receipt['accepted'])
    def test_isolated_python_cli_bootstrap(self):
        action='plan'if os.name=='nt'else'apply'
        result=subprocess.run([sys.executable,'-I',str(HERE/'v2-plan.py'),action],capture_output=True,timeout=5)
        receipt=json.loads(result.stdout)
        if action=='plan':
            self.assertEqual(result.returncode,0);self.assertEqual(receipt['schema'],'ote-enforced-candidate-plan:2')
            self.assertFalse(receipt['deployment_allowed'])
        else:
            self.assertEqual(result.returncode,78);self.assertEqual(receipt['code'],'V2_INSTALLATION_BLOCKED_NO_FORCE_PATH')
    def rollback_revocation_fixture(self,already_removed=False):
        m=module('candidate_rollback','v2-plan.py')
        with rollback_fixture_directory()as directory:
            fixture=Path(directory);root=fixture/'runtime';root.mkdir()
            profile=fixture/'candidate.apparmor';profile_bytes=b'# damaged candidate policy retained as evidence\n'
            profile.write_bytes(profile_bytes)
            asset=root/'corrupt-asset.so';asset_bytes=b'not an approved library';asset.write_bytes(asset_bytes)
            original_sha=enforced.digest(profile)
            backup=root/('rollback-profile-v2-'+original_sha+'.apparmor')
            targets={'profile_file_present':True,'original_profile_sha256':original_sha,'original_profile_metadata':{'uid':0,'mode':0o644}}
            locations={C['runtime_root']:root,C['apparmor_profile_path']:profile}
            settings={'unprivileged_userns_clone':'1','apparmor_restrict_unprivileged_userns':'1'}
            def remove_only_candidate(command,**kwargs):
                self.assertEqual(command,['/usr/sbin/apparmor_parser','--remove','--skip-cache'])
                self.assertEqual(kwargs['input'],enforced.profile_text(C,LOCK).encode())
                self.assertEqual(kwargs['timeout'],15)
                self.assertTrue(profile.exists());self.assertEqual(backup.read_bytes(),profile_bytes)
                self.assertEqual(asset.read_bytes(),asset_bytes)
                return subprocess.CompletedProcess(command,0,b'',b'')
            with patch.object(m,'Path',side_effect=lambda path:locations[str(path)]),patch.object(m.install,'trusted_packet')as packet_check,patch.object(m.install,'browsers',return_value=[])as browsers,patch.object(m.install,'loaded',side_effect=[False]if already_removed else[True,False])as loaded,patch.object(m.install,'settings',return_value=settings)as host_settings,patch.object(enforced,'rollback_targets',return_value=targets)as target_check,patch.object(enforced,'validate_runtime',side_effect=AssertionError('CORRUPT_ASSETS_MUST_NOT_BLOCK_REVOCATION'))as runtime_check,patch.object(policy,'validate_assets',side_effect=AssertionError('CORRUPT_ASSETS_MUST_NOT_BLOCK_REVOCATION'))as asset_check,patch.object(subprocess,'run',side_effect=remove_only_candidate)as parser:
                result=m.rollback(C,LOCK)
            self.assertEqual(result['status'],'V2_REVOKED');self.assertTrue(result['global_settings_unchanged'])
            self.assertFalse(profile.exists());self.assertTrue(root.is_dir())
            self.assertEqual(asset.read_bytes(),asset_bytes);self.assertEqual(backup.read_bytes(),profile_bytes)
            self.assertEqual(result['retained_runtime_mode'],'0700')
            packet_check.assert_called_once_with();target_check.assert_called_once_with(C)
            self.assertEqual(browsers.call_count,2);self.assertTrue(all(call.args==(C['executable'],)for call in browsers.call_args_list))
            self.assertEqual(loaded.call_count,1 if already_removed else 2);self.assertTrue(all(call.args==(C['apparmor_profile_name'],)for call in loaded.call_args_list))
            self.assertEqual(result['kernel_profile_already_removed'],already_removed)
            self.assertEqual(host_settings.call_count,2)
            if already_removed:parser.assert_not_called()
            else:parser.assert_called_once()
            runtime_check.assert_not_called();asset_check.assert_not_called()
    def test_rollback_revokes_only_exact_profile_and_preserves_corrupt_asset(self):self.rollback_revocation_fixture()
    def test_rollback_handles_already_removed_kernel_profile(self):self.rollback_revocation_fixture(already_removed=True)
    def test_current_installer_remains_blocked(self):
        import install
        self.assertEqual(install.deployment_blockers(policy.load(HERE/'runtime.json')),['DIRECT_ELF_LIBRARY_BOUNDARY_UNENFORCED'])


if __name__=='__main__':
    start=time.monotonic();suite=unittest.defaultTestLoader.loadTestsFromTestCase(Contracts)
    result=unittest.TextTestRunner(verbosity=1).run(suite)
    r={'schema':'ote-v2-offline-contracts:1','tests':result.testsRun,'pass':result.wasSuccessful(),
        'platform':sys.platform,'elapsed_ms':round((time.monotonic()-start)*1000),'active_policy_tested':False,
        'LIBRARY_BOUNDARY_READINESS':'OFFLINE_CONTRACTS_ONLY','SANDBOX_DEPLOYMENT_READINESS':'BLOCKED_ACTIVE_POLICY_AND_SECURITY_MODEL','accepted':False}
    if len(sys.argv)>1:Path(sys.argv[1]).write_text(json.dumps(r,indent=2)+'\n')
    print(json.dumps(r));raise SystemExit(0 if r['pass']else 2)
