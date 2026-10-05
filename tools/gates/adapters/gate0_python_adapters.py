"""Caption-only adapters for the local Gate 0 benchmark.

The CLI writes one sanitized JSON object to stdout. It never prints request URLs,
caption URLs, headers, cookies, transcript text, or exception messages.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import importlib.metadata
import json
import re
import sys
import time
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any
from urllib.request import Request

MAX_RESPONSE_BYTES = 4 * 1024 * 1024
VIDEO_ID_RE = re.compile(r"^[\w-]{11}$")
TIME_RE = re.compile(r"^(?:(\d{2,}):)?([0-5]?\d):([0-5]?\d)\.(\d{1,3})$")
TAG_RE = re.compile(r"<[^>]*>")


class TooLargeResponse(Exception):
    pass


class CaptureSession:
    """Requests session that bounds and hashes bodies without retaining URLs."""

    def __init__(self) -> None:
        import requests

        self._session = requests.Session()
        self._session.trust_env = False
        self.observations: list[dict[str, Any]] = []

    def __getattr__(self, name: str) -> Any:
        # The pinned library configures Session.headers/cookies during construction.
        return getattr(self._session, name)

    def request(self, method: str, url: str, **kwargs: Any) -> Any:
        kwargs["stream"] = True
        kwargs.setdefault("timeout", (5, 20))
        response = self._session.request(method, url, **kwargs)
        length = response.headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_RESPONSE_BYTES:
            response.close()
            raise TooLargeResponse()
        chunks: list[bytes] = []
        size = 0
        for chunk in response.iter_content(64 * 1024):
            size += len(chunk)
            if size > MAX_RESPONSE_BYTES:
                response.close()
                raise TooLargeResponse()
            chunks.append(chunk)
        body = b"".join(chunks)
        response._content = body
        response._content_consumed = True
        self.observations.append(
            {
                "http_status": int(response.status_code),
                "content_type": response.headers.get("content-type", "").split(";", 1)[0]
                or None,
                "retry_after": response.headers.get("retry-after", "")[:64] or None,
                "date": response.headers.get("date", "")[:64] or None,
                "bytes_received": len(body),
                "response_sha256": sha256(body),
            }
        )
        return response

    def get(self, url: str, **kwargs: Any) -> Any:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> Any:
        return self.request("POST", url, **kwargs)

    def close(self) -> None:
        self._session.close()


def parse_vtt(data: bytes) -> list[dict[str, Any]] | None:
    try:
        source = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None
    if not source.lstrip().startswith("WEBVTT"):
        return None
    cues: list[dict[str, Any]] = []
    blocks = re.split(r"\r?\n\s*\r?\n", source)
    for block in blocks[1:]:
        lines = [line.strip("\ufeff\r") for line in block.splitlines()]
        timing_index = next(
            (index for index, line in enumerate(lines) if "-->" in line), None
        )
        if timing_index is None:
            continue
        timing = lines[timing_index].split("-->", 1)
        if len(timing) != 2:
            return None
        start_ms = parse_vtt_time(timing[0].strip().split()[0])
        end_ms = parse_vtt_time(timing[1].strip().split()[0])
        text = normalize_text(" ".join(lines[timing_index + 1 :]))
        if not text:
            continue
        if start_ms is None or end_ms is None or end_ms < start_ms:
            return None
        cues.append(make_cue(start_ms, end_ms, text))
    return cues or None


def parse_srv3_xml(data: bytes) -> list[dict[str, Any]] | None:
    try:
        from defusedxml import ElementTree

        root = ElementTree.fromstring(data)
    except Exception:
        return None
    cues: list[dict[str, Any]] = []
    for node in root.iter():
        if node.tag.rsplit("}", 1)[-1] not in {"text", "p"}:
            continue
        text = normalize_text(html.unescape("".join(node.itertext())))
        if not text:
            continue
        start = decimal_seconds_to_ms(node.attrib.get("start") or node.attrib.get("t"))
        duration = decimal_seconds_to_ms(node.attrib.get("dur") or node.attrib.get("d"))
        if start is None or duration is None:
            return None
        cues.append(make_cue(start, start + duration, text))
    return cues or None


def parse_json3(data: bytes) -> list[dict[str, Any]] | None:
    try:
        parsed = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(parsed, dict) or not isinstance(parsed.get("events"), list):
        return None
    cues: list[dict[str, Any]] = []
    for event in parsed["events"]:
        if not isinstance(event, dict):
            return None
        segments = event.get("segs")
        if not isinstance(segments, list):
            continue
        text = normalize_text(
            "".join(
                str(segment.get("utf8", ""))
                for segment in segments
                if isinstance(segment, dict)
            )
        )
        if not text:
            continue
        start = event.get("tStartMs")
        duration = event.get("dDurationMs")
        if not isinstance(start, int) or not isinstance(duration, int):
            return None
        if start < 0 or duration < 0:
            return None
        cues.append(make_cue(start, start + duration, text))
    return cues or None


def parse_caption_payload(data: bytes, extension: str) -> list[dict[str, Any]] | None:
    if len(data) > MAX_RESPONSE_BYTES:
        raise TooLargeResponse()
    if extension.lower() in {"json3", "json"} or data.lstrip().startswith(b"{"):
        return parse_json3(data)
    if extension.lower() in {"srv3", "xml", "ttml"} or data.lstrip().startswith(b"<"):
        return parse_srv3_xml(data)
    return parse_vtt(data)


def summarize_cues(cues: list[dict[str, Any]] | None) -> dict[str, Any]:
    if not cues:
        return {"cue_count": 0, "first_cue": None, "middle_cue": None, "last_cue": None}
    return {
        "cue_count": len(cues),
        "first_cue": cues[0],
        "middle_cue": cues[(len(cues) - 1) // 2],
        "last_cue": cues[-1],
    }


def run_youtube_transcript_api(args: argparse.Namespace) -> dict[str, Any]:
    from youtube_transcript_api import YouTubeTranscriptApi

    session = CaptureSession()
    api = YouTubeTranscriptApi(http_client=session)
    tracks: list[dict[str, Any]] = []
    selected = None
    cue_summary = {
        "cue_count": None,
        "first_cue": None,
        "middle_cue": None,
        "last_cue": None,
    }
    try:
        transcript_list = api.list(args.video_id)
        tracks = [
            {
                "language_code": str(track.language_code),
                "kind": "generated" if track.is_generated else "manual",
                "name": str(track.language),
                "is_translatable": bool(track.is_translatable),
                "translation_language_count": len(track.translation_languages),
            }
            for track in transcript_list
        ]
        if args.operation == "list":
            status = "OK" if tracks else "NO_CAPTIONS"
            cues = None
            reason = None if tracks else "EMPTY_PUBLIC_TRACKLIST"
        else:
            selected = find_ytt_track(transcript_list, args.language_code, args.kind)
            if selected is None:
                status = "NO_CAPTIONS" if not tracks else "UPSTREAM_CHANGED"
                reason = "EMPTY_PUBLIC_TRACKLIST" if not tracks else "SELECTED_TRACK_MISSING"
                cues = None
            else:
                fetched = selected.fetch()
                cue_rows = []
                for snippet in fetched.snippets:
                    if not isinstance(snippet.start, (int, float)) or not isinstance(
                        snippet.duration, (int, float)
                    ):
                        raise ValueError("invalid cue timestamps")
                    start = round(float(snippet.start) * 1000)
                    end = round((float(snippet.start) + float(snippet.duration)) * 1000)
                    cue_rows.append(make_cue(start, end, str(snippet.text)))
                cues = cue_rows or None
                status = "OK" if cues else "PARSE_ERROR"
                reason = None if cues else "CAPTION_CUES_EMPTY"
        cue_summary = summarize_cues(cues)
        return result_object(
            args,
            "youtube-transcript-api",
            importlib.metadata.version("youtube-transcript-api"),
            status,
            reason,
            tracks,
            selected_track_summary(selected) if selected else None,
            cue_summary,
            session.observations,
        )
    except Exception as error:
        return result_object(
            args,
            "youtube-transcript-api",
            importlib.metadata.version("youtube-transcript-api"),
            safe_status(error, session.observations),
            safe_reason(error),
            tracks,
            selected_track_summary(selected) if selected else None,
            cue_summary,
            session.observations,
        )
    finally:
        session.close()


def run_ytdlp(args: argparse.Namespace) -> dict[str, Any]:
    import yt_dlp

    ydl_logger = QuietLogger()
    options = {
        "ignoreconfig": True,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "socket_timeout": 20,
        "retries": 0,
        "fragment_retries": 0,
        "extractor_retries": 0,
        "file_access_retries": 0,
        "writesubtitles": False,
        "writeautomaticsubtitles": False,
        "listsubtitles": False,
        "logger": ydl_logger,
        "cachedir": False,
        "extractor_args": {"youtube": {"player_client": ["default"]}},
    }
    observations: list[dict[str, Any]] = []
    tracks: list[dict[str, Any]] = []
    selected = None
    cue_summary = {
        "cue_count": None,
        "first_cue": None,
        "middle_cue": None,
        "last_cue": None,
    }
    version = importlib.metadata.version("yt-dlp")
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            original_urlopen = ydl.urlopen
            ydl.urlopen = capture_ytdlp_urlopen(original_urlopen, observations)
            info = ydl.extract_info(
                f"https://www.youtube.com/watch?v={args.video_id}", download=False
            )
            if not isinstance(info, dict):
                raise ValueError("extractor returned no video metadata")
            tracks = ytdlp_track_list(info)
            selected = find_ytdlp_track(info, args.language_code, args.kind)
            if args.operation == "list":
                status = "OK" if tracks else "NO_CAPTIONS"
                reason = None if tracks else "EMPTY_PUBLIC_TRACKLIST"
                cues = None
            elif selected is None:
                status = "NO_CAPTIONS" if not tracks else "UPSTREAM_CHANGED"
                reason = "EMPTY_PUBLIC_TRACKLIST" if not tracks else "SELECTED_TRACK_MISSING"
                cues = None
            else:
                response, body = fetch_ytdlp_track(ydl, selected)
                cues = parse_caption_payload(body, selected.get("ext", ""))
                if cues is None:
                    status = "PARSE_ERROR"
                    reason = "CAPTION_PAYLOAD_INVALID"
                else:
                    status = "OK"
                    reason = None
                selected = {**selected, "track_http_status": response.status}
            cue_summary = summarize_cues(cues)
            return result_object(
                args,
                "yt-dlp",
                importlib.metadata.version("yt-dlp"),
                status,
                reason,
                tracks,
                public_ytdlp_track(selected) if selected else None,
                cue_summary,
                observations,
            )
    except Exception as error:
        return result_object(
            args,
            "yt-dlp",
            version,
            safe_status(error, observations),
            safe_reason(error),
            tracks,
            public_ytdlp_track(selected) if selected else None,
            cue_summary,
            observations,
        )


class QuietLogger:
    def debug(self, _message: str) -> None:
        pass

    def info(self, _message: str) -> None:
        pass

    def warning(self, _message: str) -> None:
        pass

    def error(self, _message: str) -> None:
        pass


def capture_ytdlp_urlopen(original: Any, observations: list[dict[str, Any]]) -> Any:
    def captured(request: Any) -> Any:
        try:
            response = original(request)
        except Exception as error:
            status = getattr(error, "code", None)
            if isinstance(status, int):
                observations.append(
                    {
                        "http_status": status,
                        "content_type": None,
                        "retry_after": None,
                        "date": None,
                        "bytes_received": 0,
                        "response_sha256": None,
                    }
                )
            raise
        event = {
            "http_status": int(response.status),
            "content_type": response.headers.get_content_type(),
            "retry_after": response.headers.get("Retry-After", "")[:64] or None,
            "date": response.headers.get("Date", "")[:64] or None,
            "bytes_received": 0,
            "response_sha256": None,
        }
        observations.append(event)
        original_read = response.read
        captured = bytearray()

        def bounded_read(size: int = -1) -> bytes:
            chunk = original_read(size)
            captured.extend(chunk)
            if len(captured) > MAX_RESPONSE_BYTES:
                response.close()
                raise TooLargeResponse()
            event["bytes_received"] = len(captured)
            event["response_sha256"] = sha256(bytes(captured))
            return chunk

        response.read = bounded_read
        return response

    return captured


def ytdlp_track_list(info: dict[str, Any]) -> list[dict[str, Any]]:
    tracks: list[dict[str, Any]] = []
    for kind, field in (("manual", "subtitles"), ("generated", "automatic_captions")):
        by_language = info.get(field) or {}
        if not isinstance(by_language, dict):
            continue
        for language, formats in by_language.items():
            if not isinstance(formats, list):
                continue
            for item in formats:
                if not isinstance(item, dict):
                    continue
                tracks.append(
                    {
                        "language_code": str(language),
                        "kind": kind,
                        "name": str(item.get("name") or language),
                        "extension": str(item.get("ext") or "unknown"),
                        "is_translatable": None,
                    }
                )
    return tracks


def find_ytdlp_track(
    info: dict[str, Any], language_code: str, kind: str
) -> dict[str, Any] | None:
    field = "subtitles" if kind == "manual" else "automatic_captions"
    by_language = info.get(field) or {}
    if not isinstance(by_language, dict):
        return None
    language = next(
        (
            value
            for value in by_language
            if value.lower() == language_code.lower()
            or value.lower().startswith(language_code.lower() + "-")
        ),
        None,
    )
    if language is None:
        return None
    formats = by_language.get(language) or []
    if not isinstance(formats, list):
        return None
    item = next(
        (
            entry
            for entry in formats
            if isinstance(entry, dict) and entry.get("ext") in {"json3", "vtt", "srv3", "xml", "ttml"}
        ),
        None,
    )
    if item is None or not isinstance(item.get("url"), str):
        return None
    return {"language_code": language, "kind": kind, **item}


def fetch_ytdlp_track(ydl: Any, track: dict[str, Any]) -> tuple[Any, bytes]:
    url = track["url"]
    if not isinstance(url, str) or not url.startswith("https://"):
        raise ValueError("caption track URL is not HTTPS")
    request = Request(url, headers={"accept": "text/vtt,application/json,application/xml,*/*"})
    response = ydl.urlopen(request)
    length = response.headers.get("Content-Length")
    if length and length.isdigit() and int(length) > MAX_RESPONSE_BYTES:
        response.close()
        raise TooLargeResponse()
    body = response.read(MAX_RESPONSE_BYTES + 1)
    if len(body) > MAX_RESPONSE_BYTES:
        response.close()
        raise TooLargeResponse()
    return response, body


def find_ytt_track(transcript_list: Any, language_code: str, kind: str) -> Any | None:
    tracks = list(transcript_list)
    matching = next(
        (
            track
            for track in tracks
            if track.language_code.lower() == language_code.lower()
            and bool(track.is_generated) == (kind == "generated")
        ),
        None,
    )
    if matching is not None:
        return matching
    return next(
        (
            track
            for track in tracks
            if track.language_code.lower().startswith(language_code.lower() + "-")
            and bool(track.is_generated) == (kind == "generated")
        ),
        None,
    )


def selected_track_summary(track: Any) -> dict[str, Any]:
    return {
        "language_code": str(track.language_code),
        "kind": "generated" if track.is_generated else "manual",
        "name": str(track.language),
        "is_translatable": bool(track.is_translatable),
        "translation_language_count": len(track.translation_languages),
    }


def public_ytdlp_track(track: dict[str, Any]) -> dict[str, Any]:
    return {
        "language_code": str(track.get("language_code", "unknown")),
        "kind": str(track.get("kind", "unknown")),
        "extension": str(track.get("ext", "unknown")),
        "track_http_status": track.get("track_http_status"),
    }


def result_object(
    args: argparse.Namespace,
    provider: str,
    version: str,
    status: str,
    reason: str | None,
    tracks: list[dict[str, Any]],
    selected_track: dict[str, Any] | None,
    cue_summary: dict[str, Any],
    observations: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "schema_version": "gate0-local-adapter-result-1.0",
        "request_id": args.request_id,
        "video_id": args.video_id,
        "provider": provider,
        "provider_version": version,
        "runtime": f"Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "operation": args.operation,
        "status": status,
        "reason_code": reason,
        "track_count": len(tracks),
        "available_tracks": tracks,
        "selected_track": selected_track,
        "is_translated_track": False if selected_track else None,
        **cue_summary,
        "within_duration": duration_valid(cue_summary, args.duration_seconds),
        "http_observations": observations,
        "upstream_bytes_received": sum(
            item.get("bytes_received") or 0 for item in observations
        ),
        "media_download": False,
        "elapsed_wall_ms": args.elapsed_ms,
    }


def safe_status(error: Exception, observations: list[dict[str, Any]]) -> str:
    if isinstance(error, TooLargeResponse):
        return "TOO_LARGE"
    name = type(error).__name__.lower()
    if "ipblocked" in name or "requestblocked" in name:
        return "IP_BLOCKED"
    if "toomanyrequests" in name or "ratelimit" in name:
        return "RATE_LIMITED"
    if "parse" in name or "decoding" in name:
        return "PARSE_ERROR"
    if "transcriptsdisabled" in name or "notranscriptfound" in name:
        return "UPSTREAM_CHANGED"
    if "region" in name or "geo" in name:
        return "REGION_BLOCKED"
    if "login" in name or "auth" in name or "potoken" in name:
        return "AUTH_REQUIRED"
    if "unavailable" in name:
        return "UNAVAILABLE"
    if observations:
        status = observations[-1].get("http_status")
        if status == 429:
            return "RATE_LIMITED"
        if status == 403:
            return "IP_BLOCKED"
        if isinstance(status, int) and status >= 500:
            return "TEMPORARY_FAILURE"
    return "TEMPORARY_FAILURE"


def safe_reason(error: Exception) -> str:
    if isinstance(error, TooLargeResponse):
        return "RESPONSE_SIZE_LIMIT"
    name = type(error).__name__.upper()
    return f"LIBRARY_{re.sub(r'[^A-Z0-9_]', '', name)[:48]}"


def make_cue(start_ms: int, end_ms: int, text: str) -> dict[str, Any]:
    if start_ms < 0 or end_ms < start_ms:
        raise ValueError("invalid cue timestamp")
    return {
        "start_ms": start_ms,
        "end_ms": end_ms,
        "text_sha256": sha256(normalize_text(text).encode("utf-8")),
    }


def parse_vtt_time(value: str) -> int | None:
    match = TIME_RE.fullmatch(value)
    if not match:
        return None
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2))
    seconds = int(match.group(3))
    millis = int(match.group(4).ljust(3, "0"))
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis


def decimal_seconds_to_ms(value: Any) -> int | None:
    try:
        number = Decimal(str(value))
        if not number.is_finite() or number < 0:
            return None
        return int((number * 1000).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError, TypeError):
        return None


def normalize_text(value: str) -> str:
    no_tags = TAG_RE.sub("", value)
    decoded = html.unescape(no_tags)
    return " ".join(decoded.split())


def duration_valid(summary: dict[str, Any], duration_seconds: float) -> bool | None:
    last = summary.get("last_cue")
    if not isinstance(last, dict):
        return None
    return last["end_ms"] <= round(duration_seconds * 1000) + 1000


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=["youtube-transcript-api", "yt-dlp"], required=True)
    parser.add_argument("--operation", choices=["list", "fetch"], required=True)
    parser.add_argument("--video-id", required=True)
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--language-code", default="en")
    parser.add_argument("--kind", choices=["manual", "generated"], default="manual")
    parser.add_argument("--duration-seconds", type=float, default=1)
    parser.add_argument("--elapsed-ms", type=int, default=0)
    args = parser.parse_args(argv)
    if not VIDEO_ID_RE.fullmatch(args.video_id):
        parser.error("invalid video id")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    started = time.perf_counter()
    cpu_started = time.process_time_ns()
    result = (
        run_youtube_transcript_api(args)
        if args.provider == "youtube-transcript-api"
        else run_ytdlp(args)
    )
    result["elapsed_wall_ms"] = round((time.perf_counter() - started) * 1000)
    result["process_cpu_us"] = (time.process_time_ns() - cpu_started) // 1000
    result["cpu_measurement_source"] = "time.process_time_ns; local process, not edge CPU"
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
