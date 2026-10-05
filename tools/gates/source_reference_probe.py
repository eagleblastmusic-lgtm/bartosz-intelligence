"""Read source JSON3 timing fields independently; never persist text or signed URLs."""
import hashlib
import html
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).parent / "adapters"))
from gate0_python_adapters import QuietLogger, find_ytdlp_track, fetch_ytdlp_track, parse_json3


def source_cues(payload):
    value = json.loads(payload.decode("utf-8-sig"))
    if not isinstance(value, dict) or not isinstance(value.get("events"), list):
        raise ValueError("SOURCE_SHAPE")
    rows = []
    for event in value["events"]:
        if not isinstance(event, dict):
            raise ValueError("SOURCE_EVENT_SHAPE")
        segments = event.get("segs")
        if not isinstance(segments, list):
            continue
        text = "".join(str(s.get("utf8", "")) for s in segments if isinstance(s, dict))
        text = " ".join(html.unescape(re.sub(r"<[^>]*>", "", text)).split())
        if not text:
            continue
        start, duration = event.get("tStartMs"), event.get("dDurationMs")
        if type(start) is not int or type(duration) is not int or min(start, duration) < 0:
            raise ValueError("SOURCE_TIME_MISSING_OR_INVALID")
        rows.append({"start_ms": start, "end_ms": start + duration,
                     "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()})
    return rows


def compare_source(payload, original, original_hashes):
    reference = source_cues(payload)
    replay = parse_json3(payload)
    if not reference or replay is None or len(reference) != len(replay):
        raise ValueError("CUE_COUNT_OR_PARSE_MISMATCH")
    all_deltas = [abs(c[k] - s[k]) for c, s in zip(replay, reference)
                  for k in ("start_ms", "end_ms")]
    all_text_equal = all(c["text_sha256"] == s["text_sha256"] for c, s in zip(replay, reference))
    indexes = [0, (len(reference) - 1) // 2, len(reference) - 1]
    boundaries = []
    for name, index in zip(("first_cue", "middle_cue", "last_cue"), indexes):
        candidate = original[name]
        expected = reference[index]
        boundaries.append({"boundary": name, "start_delta_ms": abs(candidate["start_ms"] - expected["start_ms"]),
                           "end_delta_ms": abs(candidate["end_ms"] - expected["end_ms"]),
                           "text_hash_match": candidate["text_sha256"] == expected["text_sha256"]})
    digest = hashlib.sha256(payload).hexdigest()
    original_boundaries_pass = all(b["start_delta_ms"] <= 250 and b["end_delta_ms"] <= 250 and b["text_hash_match"] for b in boundaries)
    count_matches = len(reference) == original["cue_count"]
    return {"source_sha256": digest, "original_payload_hash_match": digest in original_hashes,
            "source_cue_count": len(reference), "original_cue_count_match": count_matches,
            "all_cue_boundaries_compared": len(all_deltas), "all_cue_max_delta_ms": max(all_deltas),
            "all_cue_text_hashes_equal": all_text_equal, "original_boundary_samples": boundaries,
            "status": "PASS" if count_matches and original_boundaries_pass and all_text_equal and max(all_deltas) <= 250 and digest in original_hashes else "INCONCLUSIVE"}


def main():
    import yt_dlp
    root = Path("docs/verification/gate-0")
    target = root / "source-exact-reference.json"
    if target.exists():
        raise RuntimeError("REFERENCE_RUN_ALREADY_RESERVED")
    candidates = {}
    with (root / "results.jsonl").open(encoding="utf-8") as stream:
        for line in stream:
            row = json.loads(line)
            if row["provider"] == "yt-dlp captions-only" and row["operation"] == "fetch_track" and row["status"] == "OK":
                candidates[row["video_id"]] = {"result": row["result"], "request_id": row["request_id"],
                                               "hashes": row["raw_response_sha256"], "stratum": row["primary_stratum"]}
    evidence = {"started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "source": "Official YouTube JSON3 tStartMs/dDurationMs; separate fresh reference read, independent timing-field reader",
                "limitations": "Same extractor only resolves public source URLs; source verification is not independent upstream/runtime availability. Full-cue replay proves same-input parser fidelity only when original raw hash matches; original three stored boundaries are directly compared.",
                "acquisition_retries_added": 0, "reference_max_cases": len(candidates), "automatic_retries": 0,
                "candidate_revision_sha256": hashlib.sha256(Path("tools/gates/adapters/gate0_python_adapters.py").read_bytes()).hexdigest(),
                "cases": [], "status": "RUNNING"}
    target.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    options = {"ignoreconfig": True, "quiet": True, "no_warnings": True, "noplaylist": True,
               "skip_download": True, "socket_timeout": 20, "retries": 0, "fragment_retries": 0,
               "extractor_retries": 0, "file_access_retries": 0, "cachedir": False, "logger": QuietLogger(),
               "extractor_args": {"youtube": {"player_client": ["default"]}}}
    for video, candidate in candidates.items():
        row = {"video_id": video, "stratum": candidate["stratum"], "candidate_request_id": candidate["request_id"]}
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                info = ydl.extract_info("https://www.youtube.com/watch?v=" + video, download=False)
                selected = candidate["result"]["selected_track"]
                track = find_ytdlp_track(info, selected["language_code"], selected["kind"])
                if track is None or track.get("ext") != "json3":
                    raise ValueError("REFERENCE_JSON3_TRACK_REQUIRED")
                query = parse_qs(urlparse(track["url"]).query)
                lang, translated = query.get("lang", [None])[0], query.get("tlang", [None])[0]
                row["translated"] = bool(translated and translated != lang)
                response, body = fetch_ytdlp_track(ydl, track)
                row.update({"http_status": response.status, "content_type": response.headers.get_content_type(),
                            "bytes": len(body), **compare_source(body, candidate["result"], candidate["hashes"])})
                if row["translated"]:
                    row["status"] = "INCONCLUSIVE_TRANSLATED_SOURCE"
        except Exception as error:
            row.update({"status": "INCONCLUSIVE", "error_type": type(error).__name__})
        evidence["cases"].append(row)
        target.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
        if row["status"] != "PASS":
            # Stop; no blind retries, alternative libraries or same-IP storm.
            break
    evidence["status"] = "PASS" if len(evidence["cases"]) == len(candidates) and all(c["status"] == "PASS" for c in evidence["cases"]) else "INCONCLUSIVE"
    evidence["completed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    target.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": evidence["status"], "verified_cases": len(evidence["cases"]), "expected": len(candidates)}))


if __name__ == "__main__":
    main()
