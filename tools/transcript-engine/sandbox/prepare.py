"""Pin and inspect an ARM64 browser ZIP locally; never runs or installs it."""
import argparse
from hashlib import sha256
import io
import json
from pathlib import Path, PurePosixPath
import stat
import time
import urllib.request
import zipfile
from policy import load,validate_config,validate_assets,profile_text,require

HERE=Path(__file__).resolve().parent


def inspect_archive(c,blob):
    require(sha256(blob).hexdigest()==c['archive_sha256'],'ARCHIVE_HASH_MISMATCH')
    files={}
    prefix='chrome-headless-shell-linux-arm64/'
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        require(len(archive.infolist())<=512,'ZIP_ENTRY_LIMIT')
        require(sum(e.file_size for e in archive.infolist())<600*1024*1024,'ZIP_TOTAL_LIMIT')
        for entry in archive.infolist():
            require(entry.filename.startswith(prefix),'ZIP_PREFIX')
            require(not stat.S_ISLNK(entry.external_attr>>16),'ZIP_SYMLINK_FORBIDDEN')
            if entry.is_dir():continue
            name=entry.filename[len(prefix):]
            p=PurePosixPath(name)
            require(str(p)==name and not p.is_absolute() and '..' not in p.parts and '\\' not in name,'ZIP_PATH')
            require(name not in files,'ZIP_DUPLICATE')
            require(entry.file_size<=400*1024*1024,'ZIP_FILE_LIMIT')
            data=archive.read(entry)
            files[name]={'sha256':sha256(data).hexdigest(),'bytes':len(data),
                         'mode':0o750 if name=='chrome-headless-shell' else 0o640}
            if name=='chrome-headless-shell':
                require(data[:6]==b'\x7fELF\x02\x01' and int.from_bytes(data[18:20],'little')==183,'ARM64_ELF_REQUIRED')
    result={'schema':'ote-browser-assets:1','archive_sha256':c['archive_sha256'],'files':files}
    validate_assets(c,result)
    return result


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--archive',required=True,type=Path)
    parser.add_argument('--download',action='store_true')
    args=parser.parse_args()
    c=validate_config(load(HERE/'runtime.json'))
    if not args.archive.exists():
        require(args.download,'PINNED_ARCHIVE_REQUIRED')
        args.archive.parent.mkdir(parents=True,exist_ok=True)
        started=time.monotonic();size=0
        with urllib.request.urlopen(c['archive_url'],timeout=20) as response,args.archive.open('xb') as f:
            require(response.status==200,'ARCHIVE_HTTP_FAILURE')
            while True:
                data=response.read(1024*1024)
                if not data:break
                size+=len(data)
                require(size<256*1024*1024 and time.monotonic()-started<90,'ARCHIVE_DOWNLOAD_LIMIT')
                f.write(data)
    result=inspect_archive(c,args.archive.read_bytes())
    (HERE/'assets.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    (HERE/(c['apparmor_profile_name']+'.apparmor')).write_text(profile_text(c),encoding='utf-8')
    print(json.dumps({'status':'PASS_ARTIFACT_INSPECTION_ONLY','files':len(result['files']),
        'uncompressed_bytes':sum(v['bytes']for v in result['files'].values()),'archive_sha256':c['archive_sha256'],
        'host_changes':0,'browser_executions':0}))


if __name__=='__main__':main()
