"""Fail-closed contract for a root-managed, single-account Chromium runtime."""
from __future__ import annotations
from hashlib import sha256
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat

BASE = '/opt/bartosz-intelligence/browser-runtimes'
FIXED_ARGS = [
    '--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-extensions', '--disable-default-apps', '--disable-breakpad', '--disable-dev-shm-usage',
    '--autoplay-policy=user-gesture-required', 'about:blank']


class Rejected(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise Rejected(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def load(path, limit=2*1024*1024):
    require(path.stat().st_size <= limit, 'CONFIG_SIZE_LIMIT')
    data = path.read_bytes()
    require(len(data) <= limit, 'CONFIG_SIZE_LIMIT')
    return json.loads(data)


def validate_config(c):
    require(c.get('schema') == 'ote-managed-browser:1', 'CONFIG_SCHEMA')
    v = c.get('version', '')
    require(isinstance(v, str) and re.fullmatch(r'\d{1,4}(?:\.\d{1,6}){3}', v), 'VERSION_INVALID')
    root = f'{BASE}/chromium-headless-shell-{v}'
    name = 'bartosz-ote-chromium-' + v.replace('.', '_')
    expected = {'runtime_root':root,'executable':root+'/chrome-headless-shell','launcher':root+'/launcher.py',
        'apparmor_profile_name':name,'apparmor_profile_path':'/etc/apparmor.d/'+name,
        'archive_url':f'https://cdn.playwright.dev/builds/cft/{v}/linux-arm64/chrome-headless-shell-linux-arm64.zip',
        'account':'bartosz-executor','uid':997,'gid':988,'sandbox_required':True,
        'profile_parent':'/tmp','profile_prefix':'bartosz-ote-profile-',
        'node_executable':'/opt/bartosz-intelligence/runtime/node-24.21.0/bin/node'}
    for key,value in expected.items():
        require(type(c.get(key)) is type(value) and c[key] == value, 'CONFIG_'+key.upper())
    require(set(c) == set(expected) | {'schema','version','archive_sha256','executable_sha256'}, 'UNKNOWN_CONFIG_FIELD')
    for key in ['archive_sha256','executable_sha256']:
        require(isinstance(c.get(key),str) and re.fullmatch('[a-f0-9]{64}',c[key]),'HASH_INVALID')
    return c


def profile_text(c):
    validate_config(c)
    return ('# Exact root-managed executable; scoped userns exception, not filesystem confinement.\n'
        'abi <abi/4.0>,\ninclude <tunables/global>\n\n'
        f'profile {c["apparmor_profile_name"]} {c["executable"]} flags=(unconfined) {{\n  userns,\n}}\n')


def validate_profile(c, text):
    require(text.replace('\r\n','\n') == profile_text(c), 'PROFILE_CONTENT_MISMATCH')


def metadata(path):
    s = path.lstat()
    return {'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode),
        'regular':stat.S_ISREG(s.st_mode),'directory':stat.S_ISDIR(s.st_mode),'symlink':stat.S_ISLNK(s.st_mode)}


def check_meta(m, directory=False, gid=None, mode=None):
    require(not m['symlink'], 'SYMLINK_FORBIDDEN')
    require(m['directory'] if directory else m['regular'], 'FILE_TYPE_INVALID')
    require(m['uid'] == 0, 'ROOT_OWNERSHIP_REQUIRED')
    require(not m['mode'] & 0o022, 'WRITABLE_BY_NONROOT')
    require(not m['mode'] & 0o7000, 'SPECIAL_MODE_FORBIDDEN')
    if gid is not None:
        require(m['gid'] == gid, 'GROUP_MISMATCH')
    if mode is not None:
        require(m['mode'] == mode, 'MODE_MISMATCH')


def secure_ancestors(path):
    # Symlinks must be rejected before any resolve() normalization.
    for parent in reversed(path.parents):
        check_meta(metadata(parent), directory=True)


def validate_assets(c, assets):
    require(assets.get('schema') == 'ote-browser-assets:1' and assets.get('archive_sha256') == c['archive_sha256'], 'ASSET_MANIFEST_IDENTITY')
    rows = assets.get('files')
    require(isinstance(rows,dict) and 1 <= len(rows) <= 512, 'ASSET_COUNT')
    total = 0
    for name,row in rows.items():
        path = PurePosixPath(name)
        require(str(path) == name and not path.is_absolute() and all(p not in {'.','..',''} for p in path.parts)
            and '\\' not in name and ':' not in name, 'ASSET_PATH_INVALID')
        require(name not in {'launcher.py','policy.py','runtime.json','assets.json','install-receipt.json','rollback.json'}, 'CONTROL_NAME_COLLISION')
        require(set(row) == {'sha256','bytes','mode'}, 'ASSET_FIELDS')
        require(isinstance(row['sha256'],str) and re.fullmatch('[a-f0-9]{64}',row['sha256']), 'ASSET_HASH')
        require(type(row['bytes']) is int and 0 < row['bytes'] <= 400*1024*1024, 'ASSET_SIZE')
        require(row['mode'] == (0o750 if name == 'chrome-headless-shell' else 0o640), 'ASSET_MODE')
        require(not name.endswith(('chrome-sandbox','chrome_sandbox')), 'SETUID_HELPER_NOT_ALLOWED')
        total += row['bytes']
    require(total < 600*1024*1024, 'ASSET_TOTAL_LIMIT')
    require(rows.get('chrome-headless-shell',{}).get('sha256') == c['executable_sha256'], 'EXECUTABLE_HASH_MISMATCH')
    return rows


def account_matches(c):
    import pwd,grp
    account = pwd.getpwnam(c['account'])
    require((account.pw_uid, account.pw_gid) == (c['uid'],c['gid']), 'ACCOUNT_ID_CHANGED')
    require([p.pw_name for p in pwd.getpwall() if p.pw_gid == c['gid']] == [c['account']], 'GROUP_NOT_DEDICATED')
    require(set(grp.getgrgid(c['gid']).gr_mem) <= {c['account']}, 'EXTRA_GROUP_MEMBER')
    require(not [g for g in grp.getgrall() if c['account'] in g.gr_mem and g.gr_gid != c['gid']], 'SUPPLEMENTARY_GROUPS_FORBIDDEN')


def validate_runtime(c, check_profile=True, allow_inactive=False):
    validate_config(c)
    require(os.name == 'posix', 'LINUX_REQUIRED')
    account_matches(c)
    root = Path(c['runtime_root'])
    secure_ancestors(root)
    root_meta=metadata(root)
    root_mode=0o700 if allow_inactive and root_meta['mode']==0o700 else 0o750
    check_meta(root_meta,directory=True,gid=c['gid'],mode=root_mode)
    for name in ['launcher.py','policy.py','runtime.json','assets.json']:
        p = root/name
        check_meta(metadata(p),gid=c['gid'],mode=0o750 if name=='launcher.py' else 0o640)
        require('security.capability' not in os.listxattr(p),'FILE_CAPABILITIES_FORBIDDEN')
    assets = load(root/'assets.json')
    rows = validate_assets(c,assets)
    known = set(rows) | {'launcher.py','policy.py','runtime.json','assets.json','install-receipt.json','rollback.json'}
    for p in root.rglob('*'):
        name = p.relative_to(root).as_posix()
        m = metadata(p)
        if m['directory']:
            check_meta(m,directory=True,gid=c['gid'],mode=0o750)
        else:
            require(name in known, 'UNMANAGED_RUNTIME_FILE')
            check_meta(m,gid=c['gid'],mode=rows[name]['mode'] if name in rows else 0o750 if name=='launcher.py' else 0o640)
            require('security.capability' not in os.listxattr(p), 'FILE_CAPABILITIES_FORBIDDEN')
    for name,row in rows.items():
        p = root/name
        require(p.stat().st_size == row['bytes'], 'ASSET_SIZE_MISMATCH')
        require(sha256(p.read_bytes()).hexdigest() == row['sha256'], 'ASSET_BYTES_CHANGED')
    with (root/'chrome-headless-shell').open('rb') as f:
        elf=f.read(20)
    require(elf[:6] == b'\x7fELF\x02\x01' and int.from_bytes(elf[18:20],'little') == 183,'ARM64_ELF_REQUIRED')
    if check_profile:
        p = Path(c['apparmor_profile_path'])
        secure_ancestors(p)
        check_meta(metadata(p),gid=0,mode=0o644)
        validate_profile(c,p.read_text(encoding='utf-8'))
    return {'validated':True,'runtime_root':str(root),'files_verified':len(rows),'sandbox_requested':True}


def validate_args(c,args,uid):
    require(uid == c['uid'] and uid != 0, 'EXECUTION_ACCOUNT_REQUIRED')
    profile_args = [a for a in args if a.startswith('--user-data-dir=')]
    require(len(profile_args) == 1, 'PRIVATE_PROFILE_REQUIRED')
    # The target path is POSIX even when contracts run on Windows.
    profile = PurePosixPath(profile_args[0].split('=',1)[1])
    require(profile.is_absolute() and str(profile.parent) == c['profile_parent'] and
        re.fullmatch(re.escape(c['profile_prefix'])+'[A-Za-z0-9_-]{6,64}',profile.name), 'PRIVATE_PROFILE_PATH')
    require(len(args) == len(FIXED_ARGS)+1 and sorted(a for a in args if a not in profile_args) == sorted(FIXED_ARGS), 'UNAPPROVED_BROWSER_ARGUMENT')
    return profile


def private_profile(c,args):
    profile = Path(validate_args(c,args,os.geteuid()))
    m=metadata(profile)
    require(not m['symlink'] and m['directory'] and m['uid']==c['uid'] and m['mode']==0o700, 'PRIVATE_PROFILE_PERMISSIONS')
    require(not any(profile.iterdir()), 'PROFILE_NOT_FRESH')
    return profile


def clean_environment(profile):
    return {'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HOME':str(profile),'TMPDIR':str(profile)}
