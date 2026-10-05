"""Qualified caption helpers, full source contract; never prints URLs/headers/errors."""
from __future__ import annotations
import base64
import hashlib
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import re
import sys
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("qualified_caption_helpers", ROOT / "tools/gates/adapters/gate0_python_adapters.py")
qualified = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualified)

def decode_segments(body: bytes, extension: str):
    # Reuse qualified timing parsers without their benchmark-only text/hash summary.
    qualified.normalize_text = lambda text: text
    def cue(start, end, text):
        if not isinstance(start,int) or not isinstance(end,int) or start<0 or end<start:
            raise ValueError("invalid timestamp")
        return {"start_ms":start,"end_ms":end,"text":text,"speaker_label":None}
    qualified.make_cue = cue
    parsed = qualified.parse_caption_payload(body, extension)
    if parsed is None:
        return None
    return [{"upstream_index":index, **segment} for index,segment in enumerate(parsed)]

def tracks_from_info(info):
    result=[]
    for field,generated in (("subtitles",False),("automatic_captions",True)):
        languages=info.get(field) or {}
        if not isinstance(languages,dict): continue
        for language,formats in languages.items():
            if not isinstance(formats,list): continue
            preferred=sorted((value for value in formats if isinstance(value,dict) and value.get("ext") in {"json3","vtt","srv3","xml","ttml"}),key=lambda value: {"json3":0,"vtt":1,"srv3":2,"xml":3,"ttml":4}[value["ext"]])
            if not preferred: continue
            value=preferred[0]
            if not isinstance(value.get("url"),str) or not value["url"].startswith("https://"): continue
            locator=urlparse(value["url"])
            if locator.hostname not in {"www.youtube.com","youtube.com"} or locator.path != "/api/timedtext" or locator.port not in {None,443} or locator.username or locator.password:
                continue
            query=parse_qs(locator.query)
            translated=bool(query.get("tlang"))
            source_language=(query.get("lang") or [None])[0] if translated else None
            kind="TRANSLATED" if translated else "GENERATED" if generated else "MANUAL"
            result.append({"language_code":str(language),"track_kind":kind,"is_generated":generated,"is_translated":translated,"source_language":source_language,"translation_source_track_id":None,"is_translatable":None,"translation_languages":[],"is_original":None,"extension":value["ext"],"_url":value["url"]})
    return result

def execute(request):
    import yt_dlp
    version=importlib.metadata.version("yt-dlp")
    result={"status":"TEMPORARY_FAILURE","failure_code":"LOCAL_ADAPTER_FAILURE","provider_version":version,"python_version":".".join(map(str,sys.version_info[:3])),"tracks":[],"video_language":None,"selected":None,"segments":[],"raw_payload_base64":None,"raw_payload_hash":None,"upstream_requests":None,"bytes_received":None}
    if version != "2026.8.19" or importlib.metadata.version("yt-dlp-ejs") != "0.8.0":
        result["failure_code"]="DEPENDENCY_VERSION_MISMATCH"
        return result
    if not re.fullmatch(r"[\w-]{11}",request.get("video_id","")) or request.get("operation") not in {"list","fetch"}:
        result["failure_code"]="INVALID_LOCAL_INPUT"
        return result
    maximum=request.get("max_bytes")
    if not isinstance(maximum,int) or maximum<1 or maximum>qualified.MAX_RESPONSE_BYTES:
        result["failure_code"]="INVALID_LOCAL_INPUT"
        return result
    observations=[]
    options={"ignoreconfig":True,"quiet":True,"no_warnings":True,"noplaylist":True,"skip_download":True,"socket_timeout":10,"retries":0,"fragment_retries":0,"extractor_retries":0,"file_access_retries":0,"writesubtitles":False,"writeautomaticsubtitles":False,"logger":qualified.QuietLogger(),"cachedir":False,"extractor_args":{"youtube":{"player_client":["default"]}}}
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            ydl.urlopen=qualified.capture_ytdlp_urlopen(ydl.urlopen,observations)
            info=ydl.extract_info("https://www.youtube.com/watch?v="+request["video_id"],download=False)
            if not isinstance(info,dict): raise ValueError("no metadata")
            tracks=tracks_from_info(info)
            result["tracks"]=[{key:value for key,value in track.items() if not key.startswith("_")} for track in tracks]
            result["video_language"]=info.get("language") if isinstance(info.get("language"),str) else None
            if request["operation"]=="list":
                result.update(status="OK" if tracks else "NO_CAPTIONS",failure_code=None if tracks else "EMPTY_PUBLIC_TRACKLIST")
            else:
                track=next((track for track in tracks if track["language_code"]==request.get("language_code") and track["track_kind"]==request.get("track_kind") and track["extension"]==request.get("extension")),None)
                if track is None:
                    result.update(status="UPSTREAM_CHANGED" if tracks else "NO_CAPTIONS",failure_code="SELECTED_TRACK_MISSING" if tracks else "EMPTY_PUBLIC_TRACKLIST")
                else:
                    response,body=qualified.fetch_ytdlp_track(ydl,{"url":track["_url"]})
                    response.close()
                    if len(body)>maximum: raise qualified.TooLargeResponse()
                    segments=decode_segments(body,track["extension"])
                    if not segments: result.update(status="PARSE_ERROR",failure_code="CAPTION_PAYLOAD_INVALID")
                    else: result.update(status="OK",failure_code=None,selected={key:value for key,value in track.items() if not key.startswith("_")},segments=segments,raw_payload_base64=base64.b64encode(body).decode("ascii"),raw_payload_hash=hashlib.sha256(body).hexdigest(),bytes_received=len(body))
        result["upstream_requests"]=len(observations)
    except Exception as error:
        result.update(status=qualified.safe_status(error,observations),failure_code=qualified.safe_reason(error))
    return result

if __name__=="__main__":
    try:
        payload=sys.stdin.buffer.read(8193)
        response=execute(json.loads(payload)) if len(payload)<=8192 else {"status":"TEMPORARY_FAILURE","failure_code":"INVALID_LOCAL_INPUT"}
    except Exception:
        response={"status":"TEMPORARY_FAILURE","failure_code":"LOCAL_HARNESS_FAILURE"}
    sys.stdout.write(json.dumps(response,ensure_ascii=False,separators=(",",":")))
