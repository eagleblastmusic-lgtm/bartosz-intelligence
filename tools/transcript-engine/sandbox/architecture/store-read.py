"""Anonymous official Store metadata only. Never download or install packages."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import urllib.request

NAMES=['chromium','core24','gnome-46-2404','mesa-2404','gtk-common-themes','cups','core26']


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    if a.output.exists():raise SystemExit('NEW_STORE_OUTPUT_REQUIRED')
    rows={}
    for name in NAMES:
        url='https://api.snapcraft.io/v2/snaps/info/'+name+'?fields=name,publisher,confinement,base,epoch,channel-map,snap-yaml,download,revision,version'
        request=urllib.request.Request(url,headers={'Snap-Device-Series':'16','Snap-Device-Architecture':'arm64','User-Agent':'Bartosz-OTE-read-only-architecture-research/1'})
        with urllib.request.urlopen(request,timeout=15)as response:
            body=response.read(8*1024*1024+1)
            if len(body)>8*1024*1024:raise SystemExit('STORE_METADATA_LIMIT')
        value=json.loads(body)
        stable=[r for r in value['channel-map']if r['channel']['architecture']=='arm64'and r['channel']['track']=='latest'and r['channel']['risk']=='stable']
        if len(stable)!=1:raise SystemExit('EXACT_ARM64_STABLE_REQUIRED:'+name)
        r=stable[0]
        # Full public manifest is retained; no cookies/account tokens are used.
        rows[name]={'url':url,'response_sha256':sha256(body).hexdigest(),'response':value,'selected':r}
    receipt={'schema':'ote-browser-store-metadata:1','architecture':'arm64','anonymous':True,
        'package_downloads':0,'installs':0,'requests':len(rows),'snaps':rows,
        'compressed_one_revision_bytes':sum(r['selected']['download']['size']for r in rows.values())}
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'selected':{n:{'revision':r['selected']['revision'],'version':r['selected']['version'],
        'compressed_bytes':r['selected']['download']['size']}for n,r in rows.items()},
        'compressed_one_revision_bytes':receipt['compressed_one_revision_bytes'],'package_downloads':0}))


if __name__=='__main__':main()
