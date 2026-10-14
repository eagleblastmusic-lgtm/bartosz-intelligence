"""Qualified caption helpers, full source contract; never prints URLs/headers/errors."""
from __future__ import annotations
import base64
import hashlib
import importlib.metadata
import importlib.util
import json
import os
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
    # JSON3 includes window/newline-only control events, sometimes without a
    # duration. They carry no utterance. Preserve all source-bearing cue bytes
    # verbatim, including their surrounding whitespace; RAW preserves controls.
    if len(body) > qualified.MAX_RESPONSE_BYTES:
        raise qualified.TooLargeResponse()
    qualified.normalize_text = lambda text: text if text.strip() else ""
    def cue(start, end, text):
        if type(start) is not int or type(end) is not int or start<0 or end<start:
            raise ValueError("invalid timestamp")
        return {"start_ms":start,"end_ms":end,"text":text,"speaker_label":None}
    qualified.make_cue = cue
    if extension == 'json3':
        # Fail on malformed source-bearing rows instead of silently dropping them.
        try:
            parsed_json = json.loads(body.decode('utf-8-sig'))
        except (UnicodeError, ValueError): return None
        if not isinstance(parsed_json, dict) or not isinstance(parsed_json.get('events'), list): return None
        for event in parsed_json['events']:
            if not isinstance(event, dict): return None
            if 'segs' in event:
                if not isinstance(event['segs'], list): return None
                if any(not isinstance(row, dict) or not isinstance(row.get('utf8'), str) for row in event['segs']): return None
    if extension == 'vtt':
        try: source = body.decode('utf-8-sig')
        except UnicodeError: return None
        blocks = re.split(r'\r?\n\s*\r?\n', source.strip())
        if not blocks or not re.match(r'^WEBVTT(?:\s|$)', blocks[0]): return None
        parsed = []
        for block in blocks[1:]:
            if re.match(r'^(?:NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))', block): continue
            lines = block.splitlines()
            at = 0 if '-->' in lines[0] else 1
            if at >= len(lines) or '-->' not in lines[at]: return None
            timing = re.fullmatch(r'([^ ]+)\s+-->\s+([^ ]+)(?:\s+.*)?', lines[at])
            if not timing: return None
            start, end = map(qualified.parse_vtt_time, timing.groups())
            text = '\n'.join(lines[at+1:])
            if start is None or end is None or end < start or not text.strip(): return None
            parsed.append(cue(start,end,text))
    elif extension in {'srv3', 'xml', 'ttml'}:
        try:
            from defusedxml import ElementTree
            xml = ElementTree.fromstring(body)
            parsed = []
            for node in xml.iter():
                if node.tag.rsplit('}',1)[-1] not in {'text','p'}: continue
                text = ''.join(node.itertext())
                if not text.strip(): continue
                if 't' in node.attrib:
                    start, duration = int(node.attrib['t']), int(node.attrib['d'])
                    end = start + duration
                elif 'start' in node.attrib:
                    start = qualified.decimal_seconds_to_ms(node.attrib['start'])
                    duration = qualified.decimal_seconds_to_ms(node.attrib['dur'])
                    end = start + duration
                else:
                    start = qualified.parse_vtt_time(node.attrib['begin'])
                    end = qualified.parse_vtt_time(node.attrib['end'])
                parsed.append(cue(start,end,text))
        except Exception: return None
    else:
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
            # The pinned YouTube extractor explicitly emits -orig for the original
            # audio caption track. This is vendor provenance, not title inference.
            original = generated and str(language).endswith("-orig") and not translated
            code = str(language)[:-5] if original else str(language)
            asr = (query.get("kind") or [None])[0] == "asr" if translated else generated
            kind="TRANSLATED" if translated else "GENERATED" if generated else "MANUAL"
            result.append({"language_code":code,"track_kind":kind,"is_generated":asr,"is_translated":translated,"source_language":source_language,"translation_source_track_id":None,"is_translatable":None,"translation_languages":[],"is_original":True if original else None,"extension":value["ext"],"_url":value["url"]})
    # Compatibility aliases emitted by yt-dlp must not conceal explicit original
    # provenance or create duplicate public identities.
    unique={}
    for track in result:
        key=(track["language_code"],track["track_kind"],track["extension"],track["source_language"])
        if key not in unique or track["is_original"] is True: unique[key]=track
    result=list(unique.values())
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
    if os.environ.get('BARTOSZ_DENO'):
        options['js_runtimes'] = {'deno': {'path': os.environ['BARTOSZ_DENO']}}
    if os.environ.get('BARTOSZ_FFMPEG'):
        options['ffmpeg_location'] = os.environ['BARTOSZ_FFMPEG']
    options['remote_components'] = []
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
                    decode_response(result,body,track)
        result["upstream_requests"]=len(observations)
    except Exception as error:
        result.update(status=qualified.safe_status(error,observations),failure_code=qualified.safe_reason(error))
    return result

def decode_response(result,body,track):
    # Keep actual transport evidence even when the upstream body cannot be parsed.
    result.update(bytes_received=len(body),raw_payload_base64=base64.b64encode(body).decode("ascii"),raw_payload_hash=hashlib.sha256(body).hexdigest())
    if not body:
        # HTTP success with zero bytes is not a parser regression and does not
        # justify the owner-wide parser cooldown or claim captions are absent.
        result.update(status="TEMPORARY_FAILURE",failure_code="EMPTY_UPSTREAM_PAYLOAD")
        return
    segments=decode_segments(body,track["extension"])
    if not segments: result.update(status="PARSE_ERROR",failure_code="CAPTION_PAYLOAD_INVALID")
    else: result.update(status="OK",failure_code=None,selected={key:value for key,value in track.items() if not key.startswith("_")},segments=segments)

if __name__=="__main__":
    try:
        payload=sys.stdin.buffer.read(8193)
        response=execute(json.loads(payload)) if len(payload)<=8192 else {"status":"TEMPORARY_FAILURE","failure_code":"INVALID_LOCAL_INPUT"}
    except Exception:
        response={"status":"TEMPORARY_FAILURE","failure_code":"LOCAL_HARNESS_FAILURE"}
    sys.stdout.write(json.dumps(response,ensure_ascii=False,separators=(",",":")))
