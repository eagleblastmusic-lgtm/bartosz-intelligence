"""After owner-approved install: local page + actual /proc sandbox evidence.

Root may act as read-only observer to inspect non-dumpable renderer namespaces;
the browser is ALWAYS started with UID 997/GID 988 and no extra groups. No YouTube.
"""
import argparse
from concurrent.futures import Future
from hashlib import sha256
from http.server import BaseHTTPRequestHandler,HTTPServer
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
# Supports isolated Python (-I); the owner must stage this reviewed packet in a
# root-owned directory before running an administrative observer.
HERE=Path(__file__).absolute().parent
if os.name=='posix' and os.geteuid()==0:
    for entry in list(HERE.parents)+[HERE,HERE/'policy.py']:
        meta=entry.lstat()
        if entry.is_symlink() or meta.st_uid!=0 or meta.st_mode & 0o022:
            raise RuntimeError('ROOT_OWNED_OBSERVER_PACKET_REQUIRED')
sys.path.insert(0,str(HERE))
import policy


class CDP:
    def __init__(self,write_fd,read_fd):
        self.write_fd=write_fd;self.read_fd=read_fd;self.serial=0;self.pending={};self.events=queue.Queue(maxsize=256)
        self.lock=threading.Lock();self.thread=threading.Thread(target=self.read,daemon=True);self.thread.start()
    def read(self):
        buf=b''
        try:
            while True:
                data=os.read(self.read_fd,65536)
                if not data:raise RuntimeError('CDP_CLOSED')
                buf+=data
                if len(buf)>2*1024*1024:raise RuntimeError('CDP_SIZE_LIMIT')
                while b'\0' in buf:
                    raw,buf=buf.split(b'\0',1);m=json.loads(raw)
                    if 'id' in m:
                        with self.lock:f=self.pending.pop(m['id'],None)
                        if f:
                            if 'error' in m:f.set_exception(RuntimeError('CDP_COMMAND_FAILED'))
                            else:f.set_result(m.get('result',{}))
                    else:self.events.put_nowait(m)
        except Exception:
            with self.lock:
                self.failure=True;pending=list(self.pending.values());self.pending.clear()
            for f in pending:
                if not f.done():f.set_exception(RuntimeError('CDP_TRANSPORT_FAILED'))
    def call(self,method,params=None,session=None):
        with self.lock:
            if getattr(self,'failure',False):raise RuntimeError('CDP_TRANSPORT_FAILED')
            self.serial+=1;serial=self.serial;f=Future();self.pending[serial]=f
            raw=json.dumps({'id':serial,'method':method,'params':params or {},**({'sessionId':session}if session else {})}).encode()+b'\0'
            while raw:
                written=os.write(self.write_fd,raw);raw=raw[written:]
        try:return f.result(timeout=5)
        finally:
            with self.lock:self.pending.pop(serial,None)


class RequestGuard:
    """Handle paused requests concurrently, including before navigate responds."""
    def __init__(self,cdp,session,origin,state):
        self.cdp=cdp;self.session=session;self.origin=origin;self.state=state
        self.stop=threading.Event();self.failure=None
        self.thread=threading.Thread(target=self.run,daemon=True);self.thread.start()
    def run(self):
        from urllib.parse import urlsplit
        expected=urlsplit(self.origin)
        try:
            while not self.stop.is_set():
                try:event=self.cdp.events.get(timeout=0.1)
                except queue.Empty:continue
                if event.get('method')!='Fetch.requestPaused':continue
                policy.require(event.get('sessionId')==self.session,'UNEXPECTED_FETCH_SESSION')
                p=event['params'];u=urlsplit(p['request']['url'])
                allowed=(u.scheme,u.netloc)==(expected.scheme,expected.netloc) or u.scheme in {'blob','data'}
                if not allowed:self.state['external_requests_blocked']+=1
                self.cdp.call('Fetch.continueRequest'if allowed else 'Fetch.failRequest',
                    {'requestId':p['requestId'],**({}if allowed else {'errorReason':'Aborted'})},self.session)
        except Exception as e:self.failure=e
    def check(self):
        if self.failure:raise self.failure
    def close(self):
        self.stop.set();self.thread.join(timeout=6)


def status(pid):
    values={}
    for line in Path(f'/proc/{pid}/status').read_text().splitlines():
        k,_,v=line.partition(':')
        if k in {'Uid','Gid','NoNewPrivs','Seccomp','Seccomp_filters','CapEff','CapAmb','NSpid'}:values[k]=v.strip()
    values['namespaces']={n:os.readlink(f'/proc/{pid}/ns/{n}')for n in ['user','pid','net']}
    values['apparmor']=Path(f'/proc/{pid}/attr/current').read_text().strip()
    values['uid_map']=Path(f'/proc/{pid}/uid_map').read_text().strip()
    return values


def sandbox_assertions(c,browser,renderer):
    for item in [browser,renderer]:
        policy.require(len(item['Uid'].split())==4 and all(int(x)==c['uid'] and int(x)!=0 for x in item['Uid'].split()),'BROWSER_UID_NOT_DEDICATED')
        policy.require(len(item['Gid'].split())==4 and all(int(x)==c['gid'] for x in item['Gid'].split()),'BROWSER_GID_NOT_DEDICATED')
        policy.require(item['apparmor'].split(' ')[0]==c['apparmor_profile_name'],'PROFILE_NOT_ATTACHED')
    policy.require(renderer['Seccomp']=='2' and int(renderer.get('Seccomp_filters','0'))>=1,'RENDERER_SECCOMP_INACTIVE')
    policy.require(renderer['NoNewPrivs']=='1','RENDERER_NNP_INACTIVE')
    policy.require(int(renderer['CapEff'],16)==0 and int(renderer['CapAmb'],16)==0,'RENDERER_CAPABILITIES_PRESENT')
    for name in ['user','pid','net']:
        policy.require(renderer['namespaces'][name]!=browser['namespaces'][name],'RENDERER_NAMESPACE_SHARED_'+name.upper())
    policy.require(len(renderer['NSpid'].split())>=2,'PID_NAMESPACE_NOT_VISIBLE')


def probe(c):
    policy.require(sys.platform=='linux','LINUX_REQUIRED')
    policy.require(os.geteuid() in {0,c['uid']},'DEDICATED_ACCOUNT_OR_ADMIN_OBSERVER_REQUIRED')
    policy.validate_runtime(c)
    state={'requests':0,'external_requests_blocked':0}
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state['requests']+=1
            content=b'<!doctype html><meta charset=utf-8><div id=state>SANDBOX_LOOPBACK_OK</div><script>new Worker(URL.createObjectURL(new Blob(["setInterval(()=>{},1000)"])))</script>'
            self.send_response(200);self.send_header('Content-Type','text/html');self.send_header('Content-Length',str(len(content)));self.end_headers();self.wfile.write(content)
        def log_message(self,*_):pass
    server=HTTPServer(('127.0.0.1',0),Handler)
    directory=tempfile.mkdtemp(prefix=c['profile_prefix'],dir=c['profile_parent']);profile=Path(directory)
    os.chmod(profile,0o700)
    if os.geteuid()==0:os.chown(profile,c['uid'],c['gid'])
    input_read,input_write=os.pipe();output_read,output_write=os.pipe()
    args=policy.FIXED_ARGS[:-1]+['--user-data-dir='+str(profile),'about:blank']
    policy.validate_args(c,args,c['uid'])
    # Numeric fd redirection only; no user-provided shell code or interpolation.
    command=['/bin/sh','-c','exec 3<&"$1" 4>&"$2"; shift 2; exec "$@"','ote-cdp',str(input_read),str(output_write),c['launcher']]+args
    kwargs={'user':c['uid'],'group':c['gid'],'extra_groups':[]}if os.geteuid()==0 else {}
    child=None;cdp=None;thread=None;guard=None;watchdog=None;stderr_reader=None
    stderr=bytearray();stderr_overflow=threading.Event();started=time.monotonic()
    origin=f'http://127.0.0.1:{server.server_port}'
    try:
        child=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,
            pass_fds=(input_read,output_write),start_new_session=True,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},**kwargs)
        os.close(input_read);input_read=-1;os.close(output_write);output_write=-1
        def stop_tree():
            try:os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError:pass
        def drain_stderr():
            while True:
                data=child.stderr.read(4096)
                if not data:return
                if len(stderr)+len(data)>65536:
                    stderr_overflow.set();stop_tree();return
                stderr.extend(data)
        stderr_reader=threading.Thread(target=drain_stderr,daemon=True);stderr_reader.start()
        watchdog=threading.Timer(30,stop_tree);watchdog.daemon=True;watchdog.start()
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        cdp=CDP(input_write,output_read)
        version=cdp.call('Browser.getVersion')
        policy.require(str(version.get('product','')).endswith('/'+c['version']),'BROWSER_VERSION_MISMATCH')
        targets=cdp.call('Target.getTargets')['targetInfos'];pages=[p for p in targets if p['type']=='page']
        policy.require(len(pages)==1,'SINGLE_PAGE_REQUIRED')
        session=cdp.call('Target.attachToTarget',{'targetId':pages[0]['targetId'],'flatten':True})['sessionId']
        cdp.call('Page.enable',session=session);cdp.call('Runtime.enable',session=session)
        guard=RequestGuard(cdp,session,origin,state)
        cdp.call('Fetch.enable',{'patterns':[{'urlPattern':'*'}]},session)
        cdp.call('Page.navigate',{'url':origin+'/'},session)
        deadline=time.monotonic()+10;content=False
        while time.monotonic()<deadline and not content:
            guard.check()
            expression="document.getElementById('state')?.textContent === 'SANDBOX_LOOPBACK_OK'"
            r=cdp.call('Runtime.evaluate',{'expression':expression,'returnByValue':True},session)
            content=r.get('result',{}).get('value') is True
            if not content:time.sleep(0.05)
        policy.require(content,'LOCAL_PAGE_NOT_LOADED')
        guard.check();policy.require(not stderr_overflow.is_set(),'STDERR_LIMIT')
        # Main process stays alive while the observer inspects actual renderer state.
        main=status(child.pid);renderers=[]
        for path in Path('/proc').iterdir():
            if not path.name.isdigit():continue
            try:
                cmd=(path/'cmdline').read_bytes().split(b'\0')
                if b'--type=renderer'not in cmd:continue
                if os.readlink(path/'exe')!=c['executable']:continue
                if os.getpgid(int(path.name))!=child.pid:continue
                info=status(int(path.name))
                # Require this launch's process group, exact executable and account.
                if int(info['Uid'].split()[0])!=c['uid']:continue
                forbidden={b'--no-sandbox',b'--disable-seccomp-filter-sandbox',b'--disable-namespace-sandbox',b'--disable-setuid-sandbox',b'--single-process'}
                policy.require(not forbidden.intersection(cmd),'UNSAFE_RENDERER_FLAGS')
                sandbox_assertions(c,main,info);renderers.append({'pid':int(path.name),**info})
            except FileNotFoundError:continue
        policy.require(bool(renderers),'NO_VERIFIED_RENDERER')
        return {'SANDBOX_READINESS':'PASS_CONTROLLED_LOCAL_PAGE','LIVE_SOURCE_ACCESS':'BLOCKED_AUTHORIZATION',
            'accepted':False,'browser_uid':c['uid'],'browser':main,'renderers':renderers,'loopback':state,
            'root_is_observer_only':os.geteuid()==0,'host_configuration_changed':False,
            'elapsed_ms':round((time.monotonic()-started)*1000)}
    finally:
        if guard:guard.close()
        if cdp:
            try:cdp.call('Browser.close')
            except Exception:pass
        if child:
            try:os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            child.wait(timeout=5)
            if stderr_reader:stderr_reader.join(timeout=2)
            child.stderr.close()
        if watchdog:watchdog.cancel()
        if thread:server.shutdown();thread.join(timeout=2)
        server.server_close()
        for fd in [input_read,input_write,output_read,output_write]:
            if fd>=0:
                try:os.close(fd)
                except OSError:pass
        import shutil
        policy.require(profile.parent==Path(c['profile_parent'])and profile.name.startswith(c['profile_prefix']),'CLEANUP_BOUNDARY')
        shutil.rmtree(profile)


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--config',type=Path,default=Path(__file__).with_name('runtime.json'))
    p.add_argument('--owner-authorized',action='store_true')
    p.add_argument('--output',required=True,type=Path)
    args=p.parse_args();c=policy.validate_config(policy.load(args.config))
    if not args.owner_authorized:
        result={'SANDBOX_READINESS':'BLOCKED_HOST_CHANGE_APPROVAL','LIVE_SOURCE_ACCESS':'BLOCKED_AUTHORIZATION',
            'accepted':False,'browser_executions':0,'host_changes':0}
    else:
        try:result=probe(c)
        except Exception as e:
            result={'SANDBOX_READINESS':'FAIL_CLOSED','LIVE_SOURCE_ACCESS':'BLOCKED_AUTHORIZATION',
                'code':str(e)if isinstance(e,policy.Rejected)else type(e).__name__,'accepted':False}
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result))
    return 0 if result['SANDBOX_READINESS']in {'PASS_CONTROLLED_LOCAL_PAGE','BLOCKED_HOST_CHANGE_APPROVAL'}else 2


if __name__=='__main__':raise SystemExit(main())
