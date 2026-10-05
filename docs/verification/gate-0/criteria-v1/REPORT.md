# Gate 0 — current CP-1.6 result

Status: **FAIL / Stage 01 BLOCKED / Stage 02 NO-GO**. Evaluation: FINAL_EVALUATION.json.

Second window preregistered at13:29–14:29 Europe/Warsaw before execution. Exact reason: "schedule adjustment before second live measurement; no corpus, threshold or pass-criteria change". v1/v2 archives and schedule-adjustment-v3.json preserve full history; schedule-adjustment-v3-run-proof.json proves original99rows and frozen implementation unchanged through the39new rows. Current manifest d944e2c2f0f4c6164c6c7f32b788b509ba3c915b2350fea47e089a9dfd3a2c81.

40videos /28channels /36eligible /4natural no-captions; all40 measured across two windows. Captions acquisition35/36=97.22%; exact-source comparison35/35 PASS, zero boundary delta, original input hashes match. Manual UI spot checks cover5caption strata. These results are distinct from functional admission. Seven genuine source cue ends exceed video duration by1360–2780ms, above frozen1000ms tolerance. Functional success28/36=77.78% <95%; missing transient case recovery would only reach29/36=80.56%. No clipping, guessed end times, denominator exclusion, fifth attempt, paid route or threshold change.

Edge remains CPU FAIL (p95 62/max63ms; one optimized retest59ms). Local measured CPU is separately recorded, not Cloudflare CPU or wall time. Local runtime recovery was exercised, but source-duration sanity gate failed. No PRIMARY activated. youtube-transcript-api harness-invalid history is INCONCLUSIVE, not provider failure; shared upstream/IP does not provide independent redundancy.

No final retry: gdmuCVhzoAs remains retryable TEMPORARY_FAILURE; one transient is not permanent provider failure. Retrying cannot fix7 source-exact duration conflicts. No additional runtime deployment or alternate library storm can resolve an identical upstream payload. Owner decision is needed on this admission conflict before any changed preregistration; original FAIL remains immutable evidence. CP-1.7/1.8 NOT_STARTED.

Source reference limitations: Same extractor only resolves public source URLs; source verification is not independent upstream/runtime availability. Full-cue replay proves same-input parser fidelity only when original raw hash matches; original three stored boundaries are directly compared.

Local tests and revision refs are recorded in cp-1.6-local-verification.json. The acquisition row status OK remains raw evidence; FINAL_EVALUATION explicitly applies duration sanity and prevents mistaking fetch success for Gate PASS.

## Earlier preregistration and measurement history (superseded status statements)

# Gate 0 — preregistration (CP-1.5)

Status: **CP-1.5 PASS / corpus frozen; live benchmark NOT_RUN**  
As of: 2026-10-04  
Manifest: `MANIFEST.json`  
Manifest SHA-256: `999f680ce90d39ab1ec33fc35c94510ebaa8206c952126a3dc7bbfb477827770`  
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

Candidate comparisons are explicit in `REQUEST_PLAN.json`: Direct Captions Edge on Cloudflare Workers Free is the cloud-runtime candidate; `youtube-transcript-api` and captions-only `yt-dlp` are local-runtime candidates. The 40 cases are split evenly across 12:23 and 18:23 Europe/Warsaw, alternating within every primary stratum (20 cases per window; each stratum is balanced). The local results can establish local feasibility but cannot establish Cloudflare access or CPU. The Edge candidate must report actual platform CPU and bytes; wall-clock duration is not CPU. The Free invocation limit is 10 ms, with the Gate 0 target p95 at or below 8 ms and maximum below 10 ms.

For `TEMPORARY_FAILURE` and `RATE_LIMITED`, the maximum is four attempts with full-jitter delays based on 1, 5, 20, and 60 minutes, scheduled in the 12:23 and 18:23 Europe/Warsaw windows. No immediate retry, same-IP extractor storm, paid route, trial credits, or media download is allowed. Natural no-caption rechecks follow the separate 1h, 6h, 24h, 3d, 7d, then weekly schedule. All initial and final outcomes must be preserved.

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

## Preregistration version 2 — schedule only

Reason: `schedule adjustment before first live measurement`. Registered at 2026-10-05T10:23:00.515Z, before any live request or Preview creation. Today, Europe/Warsaw: 12:23–13:23 and 18:23–19:23; 360 minutes between starts. Prior manifest/request plan/report are preserved in `preregistration-v1/`. Current manifest hash: `999f680ce90d39ab1ec33fc35c94510ebaa8206c952126a3dc7bbfb477827770`. All non-schedule benchmark parameters are identical (invariant hash `2687601c22abdd66c7041e5e014c220dab986060e9b5ad04c51690727ab86c6d`); corpus, strata assignments, denominator, PASS thresholds and retry cap remain unchanged. `schedule-adjustment-v2.json` records both versions. Historical readiness notes above refer to version 1; the current window is 12:23.

Runner schedule checks now use the registered minute-level starts with the same 60-minute window duration. Local verification: 20 contract tests PASS; first live run follows verification.


## CP-1.6 first live window — 2026-10-05

Schedule v2 was frozen before any Preview/live measurement: 12:23–13:23 and 18:23–19:23 Europe/Warsaw. Reason: `schedule adjustment before first live measurement`. Corpus, denominators, thresholds and all other parameters are unchanged; v1 is retained.

First window measured 20 assigned videos per candidate (61 operation records including yt-dlp list/fetch). DirectCaptionsEdge returned PLAYABILITY_LOGIN_REQUIRED for all 20; this is AUTH_REQUIRED, not proof of unavailable videos. youtube-transcript-api had 20 local subprocess failures; yt-dlp had 17 local subprocess failures, one successful caption fetch and two natural no-caption results. These process failures are INCONCLUSIVE / HARNESS_FAILURE, not provider failures. Raw records remain immutable; interpretations are in first-window-annotations.json. No full-corpus success rate or timestamp fidelity PASS is claimed.

The first Preview creation failed only on the Wrangler JSON shape before YouTube calls; its cleanup succeeded. A nested-preview parser fixture passed before the live batch. The missing CaptureSession.headers defect was reproduced without network and fixed; five Python tests PASS. UTF-8 subprocess output is now explicit, but the exact original yt-dlp subprocess cause is not proven. No further live calls were made after this batch.

Actual platform CPU captured from the exact Preview Observability dashboard: 20 invocation records, p95 62 ms, maximum 63 ms; frozen limits p95 ≤8 ms and maximum <10 ms. CPU FAIL, including on the refusal path. Evidence: cpu-dashboard-first-window.json. OAuth telemetry HTTP 403 is retained separately in cpu-first-window.json; dashboard access required no credential/permission/billing changes. Both temporary Previews were deleted; preview-runs.jsonl records cleanup.

CP-1.6 / Stage 01: BLOCKED at measured CPU gate failure; Stage 02 NO-GO. Second window remains preregistered but unexecuted. Next required work is bounded decomposition per CP-1.7 dependency policy and correction of harness before any further live measurement; no alternative runtime or architecture change is yet qualified. No billing, paid fallback or corpus/threshold changes.
Final local verification after first-window evidence: Python 5/5 PASS; TypeScript tools typecheck PASS; PowerShell Preview parser fixtures PASS; git diff --check PASS. Stage 01 DoD remains unmet; no final Stage 01 commit created.


## CP-1.6 CPU recovery — current state 2026-10-05

Owner authorized bounded decomposition, one controlled CPU retest and runtime recovery. Stage status is IN_PROGRESS, not permanently BLOCKED. Cloudflare remains control plane. Frozen manifest 999f680ce90d39ab1ec33fc35c94510ebaa8206c952126a3dc7bbfb477827770 is unchanged. Second window is still 18:23–19:23; it must use the corrected local implementation.

Platform component experiment (three samples per synthetic mode, 1,316,765 bytes): control 0/0/0 ms, SHA-256 4/3/3, decode 3/2/3, player extract 1/1/0, 1KiB-chunk body read/copy 10/11/10. Fixture setup is included where applicable. Removed a redundant full-response copy before SHA-256; regression covers exact buffer views. Exactly ONE live CPU retest returned 59 ms CPU and 1116 ms external wall time, 1,383,837 upstream bytes. It remains CPU FAIL against <=8 ms p95 / <10 ms max. One sample proves maximum failure, not corpus p95. Original 62ms cannot be exactly split retrospectively: only aggregate CPU was retained, and synthetic/real response differences confound phase subtraction. Network waiting is never counted as CPU. Local instrumented canary measured fetch/header and stream processing separately from wall time; these include actual transport/decompression work and runtime startup, not pure network wait. Detailed safe evidence is in cpu-decomposition-local.json, cpu-retest-platform.json and local-runtime-canary.json.

Master sections 4/26.1/27.2 and CP-1.7(3) allow this measured recovery. Existing local Python captions-only execution is the smallest available alternative; no Deno account or paid service was provisioned. Direct Captions Local canary got an empty HTTP 200 caption body and remains PARSE_ERROR. yt-dlp local canary succeeded with 988 cues, 1,250,000 us process CPU and 2393 ms wall time. Local compute is not subject to the Cloudflare invocation cap; edge thresholds remain unchanged. This is qualification, not production activation or capacity PASS.

Resumed invalid first-window yt-dlp observations with earlier attempts retained. Current result: 20 assigned videos, 18 eligible, 17 successful captions, 2 natural no-caption cases, 1 harness-inconclusive case. Three failures were proven ENOBUFS, not provider failures. Local fixture reproduced the default 1MiB child-process buffer failure; explicit bounded 8MiB JSON capture passed. Two cases then succeeded at final allowed attempt 4. JpFhmu6jpB8 has used 3 attempts; its earliest fourth attempt is 13:24:38, after first-window closure, so it awaits 18:23. No fifth attempt. No immediate retry or new Cloudflare workload run.

Unmeasured corpus cases are now reported separately from provider failures; harness failures are INCONCLUSIVE. Full denominator remains 36 and global coverage is 17/36, not a final success rate. Five official YouTube UI source spot checks (EN manual/generated, PL manual/generated, other language) match cue counts and three boundary text hashes per video. UI time is integer seconds with no end timestamp, so frozen 250ms fidelity remains INCONCLUSIVE. Five temporary transcript exports were deleted; no source text persisted in repo.

Checks: Gate 0 contracts 24/24 PASS; Python 6/6 PASS; tools typecheck PASS; targeted lint PASS. Recovery Preview deleted successfully; safe metadata retained. Stage 02 NOT_STARTED / NO-GO. CP-1.7 roles and CP-1.8 DoD are pending; all transcript production roles remain disabled. No final Stage 01 commit exists. Next: corrected local second-window corpus/retry measurement, exact source fidelity qualification, then role selection/preflight and final Stage 01 verification. See runtime-recovery.json.
