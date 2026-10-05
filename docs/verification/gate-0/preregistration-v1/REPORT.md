# Gate 0 — preregistration (CP-1.5)

Status: **CP-1.5 PASS / corpus frozen; live benchmark NOT_RUN**  
As of: 2026-10-04  
Manifest: `MANIFEST.json`  
Manifest SHA-256: `59540b501a50da518d0bf3198cc34363fbeff4add6419459509fec779a4b6ba9`  
Player metadata evidence: `player-track-inventory.json`  
Source evidence SHA-256: `31b8cc0c7bc9e3b44934863b43bc8494db09dab54c141cb23f512b101395b49e`  
Dry-run plan: `REQUEST_PLAN.json` (`DRY_RUN_NO_NETWORK`, `live_requests_executed=false`)

## Corpus and evidence

The frozen corpus contains 40 publicly accessible videos from 28 distinct channels. Public YouTube watch-page player metadata was checked on 2026-10-04T20:28:10Z. The inventory records each public URL, video/channel identifiers, duration, publication date, selected track language and kind, total track count, public-access observation, and ended-live metadata where applicable. It records track descriptors only; transcript text and caption base URLs were not collected.

| Primary stratum | Frozen count | Required |
|---|---:|---:|
| EN manual | 8 | 8 |
| EN generated | 10 | 10 |
| PL manual | 6 | 6 |
| PL generated | 8 | 8 |
| Other language | 4 | 4 |
| No/late captions | 4 | 4 |

The independent crosscuts are Shorts 5 (minimum 4), ended live 5 (minimum 4), longer than 60 minutes 6 (minimum 6), published within 48 hours of the frozen `as_of` time 8 (minimum 8), and older than 90 days 29 (minimum 8). Ended-live timestamps and source references are retained in the frozen entries and linked player inventory.

The four no/late-caption baseline cases are `r26EVyQl_NA`, `CdX7uCXpYe4`, `QndanaE1eqg`, and `trDtjNmzoZc`; each had an empty public player caption-track list at collection time. They are kept separate from provider failures. An `IP_BLOCKED` or other access failure must never be reclassified as `NO_CAPTIONS`.

## Frozen measurement contract

The denominator is 36 caption-eligible unique video IDs out of the full 40-video corpus; four natural no-caption cases are reported separately. Attempts do not increase the denominator, and failures remain attached to their preregistered video. The minimum success threshold is 95% `OK` among eligible videos after bounded retries; `PARTIAL` is not a success. Cue timestamps are integer milliseconds, must be checked against source references, and may not be synthesized. Cue-boundary tolerance is 250 ms and end-of-duration tolerance is 1,000 ms. Overlapping cues are allowed.

Candidate comparisons are explicit in `REQUEST_PLAN.json`: Direct Captions Edge on Cloudflare Workers Free is the cloud-runtime candidate; `youtube-transcript-api` and captions-only `yt-dlp` are local-runtime candidates. The 40 cases are split evenly across 09:00 and 19:00 Europe/Warsaw, alternating within every primary stratum (20 cases per window; each stratum is balanced). The local results can establish local feasibility but cannot establish Cloudflare access or CPU. The Edge candidate must report actual platform CPU and bytes; wall-clock duration is not CPU. The Free invocation limit is 10 ms, with the Gate 0 target p95 at or below 8 ms and maximum below 10 ms.

For `TEMPORARY_FAILURE` and `RATE_LIMITED`, the maximum is four attempts with full-jitter delays based on 1, 5, 20, and 60 minutes, scheduled in the 09:00 and 19:00 Europe/Warsaw windows. No immediate retry, same-IP extractor storm, paid route, trial credits, or media download is allowed. Natural no-caption rechecks follow the separate 1h, 6h, 24h, 3d, 7d, then weekly schedule. All initial and final outcomes must be preserved.

## Verification and result

- `tools/gates/transcript-bench.ts validate`: PASS, frozen manifest, 40 videos, 28 channels, no validation errors; hash matches the value above.
- Contract tests `tests/contracts/gate0-manifest.spec.ts`: 5 passed, including quota and crosscut validation, unique-video denominator, `IP_BLOCKED` separation, and post-freeze mutation detection.
- `tsc -p tsconfig.tools.json --noEmit`: PASS.
- Targeted ESLint on the manifest harness and contract tests: PASS.
- `tools/gates/transcript-bench.ts plan`: produced the 40-row `DRY_RUN_NO_NETWORK` request plan. It executed no live requests and all three adapters remain `NOT_RUN`.

CP-1.5 exit criteria are met: the exact corpus and thresholds are frozen before measurement, all required strata and crosscuts pass, track evidence is inspectable, failure boundaries and denominator are explicit, and cloud versus local evidence boundaries are stated. CP-1.6 remains open; this report makes no claim about provider success, source access from Cloudflare, transcript fidelity, latency, or measured CPU.

## CP-1.6 runner readiness

As of 2026-10-05 11:52 Europe/Warsaw, the live harness is prepared but has not sent a video request. The 09:00 window had elapsed before this resumption; neither results.jsonl nor preview-runs.jsonl exists, and no out-of-window request was attempted. The deterministic plan was regenerated from the unchanged frozen manifest: 20 videos are assigned to each scheduled window, balanced within every primary stratum. The plan remains `DRY_RUN_NO_NETWORK`, `live_requests_executed=false`, and `paid_routes_allowed=false`.

The runner records HTTP status, content type, retry metadata, response hashes and byte counts, cue timestamps/text fingerprints, wall time, provider versions, and per-video outcomes without storing caption text or signed caption URLs. The Cloudflare Preview handler requires a random per-run guard value; it is passed only in the request body, and the application code does not emit or persist its value. The Preview name, slug, and deployment ID are retained so actual platform CPU can be collected from Preview observability before deleting the temporary deployment.

Local verification before the first scheduled request: 19 Gate 0 contract tests passed; TypeScript typecheck, targeted ESLint, PowerShell parser, and schedule-window guard passed. These checks used local fixtures only. No live provider, Cloudflare Preview, transcript fidelity, or CPU result is claimed yet. The 09:00 window elapsed before this resumption. The next eligible measurement window is 2026-10-05 19:00 Europe/Warsaw.

### Cloudflare platform CPU capture

After each Edge window, retain the exact temporary Preview until its own Preview Observability data is captured. Cloudflare documents per-Preview logs/traces in that Preview's Observability tab, event metadata including the Preview ID/name/slug and `$workers.cpuTimeMs`, and `p95`/`max` calculations. Use a time range covering only that run; record the exact Preview identity, matched event count, sample interval, CPU p95/max, query time, and evidence reference in a new `cpu-metrics.jsonl` record. Do not substitute wall time, combine Preview runs, or claim CPU if the events are missing or sampled without accounting for it. Delete the exact Preview only after capture and record successful cleanup.

Official references: [Preview test and debug](https://developers.cloudflare.com/workers/previews/test-and-debug/), [Workers Observability Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/), [Telemetry query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/). This is a capture procedure only; no Preview or CPU query has run yet.

### Retry contract note

Owner decision on 2026-10-05: preserve the frozen `maximum_attempts=4` as four total attempts (one initial request plus at most three retries); do not make a fifth attempt. Thus only the first three full-jitter caps (1/5/20 minutes) can schedule another attempt. The listed 60-minute cap is unreachable under this four-total-attempt limit and will not be used to authorize an extra request. No retry has run.
