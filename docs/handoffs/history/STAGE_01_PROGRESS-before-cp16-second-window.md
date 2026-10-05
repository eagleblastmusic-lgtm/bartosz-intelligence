# Stage 01 progress

Stage: 01
Status: IN_PROGRESS
Current checkpoint: CP-1.6 — Gate 0, local runtime recovery
Last completed checkpoints: CP-1.1–CP-1.5
Next checkpoint: corrected local second-window measurement and exact source fidelity; then CP-1.7/CP-1.8
Stage 02: NOT_STARTED / NO-GO

CP-1.1–CP-1.3 remain COMPLETE; no regression trigger. CP-1.4 / Gate E PASS: canonical gemini-3.8-flash, actual Free/account/project evidence and successful functional response. Historical invalid HTTP200 remains HARNESS_FAILURE; HTTP503 transient history. Owner professional_single_owner; billing disabled, no paid fallback. Details: docs/verification/gate-e/REPORT.md.

CP-1.5 preregistration PASS: 40 videos / 28 channels / 36 eligible / 4 natural no-captions. Frozen v2 hash999f680ce90d39ab1ec33fc35c94510ebaa8206c952126a3dc7bbfb477827770 unchanged. Windows12:23–13:23 and18:23–19:23 Warsaw. Reason schedule adjustment before first live measurement; v1 archive retained.

CP-1.6 IN_PROGRESS, not permanently BLOCKED. Edge CPU FAIL persists after bounded decomposition and removing an unnecessary SHA-256 input copy: original p95 62/max63ms; exactly ONE live retest59ms CPU /1116ms wall. Frozen <=8/<10ms unchanged. Synthetic platform components and local process-phase CPU recorded separately; exact retrospective attribution of original aggregate62ms is impossible. See cpu-retest-platform.json, cpu-decomposition-local.json, local-runtime-canary.json under docs/verification/gate-0/.

Master4/26.1/27.2 and CP-1.7(3) permit local execution; Cloudflare stays control plane. Existing local yt-dlp canary PASS (988cues,1.25s CPU/2.393s wall), production roles disabled pending qualification. DirectCaptionsLocal received emptyHTTP200 captions, not PASS. No Deno account/deployment, paid service, upgrade or trial baseline.

Corrected first-window yt-dlp:20 assigned /18 eligible /17 captions successes /2 natural no-captions /1 harness-INCONCLUSIVE. Global denominator remains36;18 unmeasured cases are not provider failures. Raw attempts retained. Three residual failures provenENOBUFS; default1MiB stdout capture reproduced locally and replaced by bounded8MiB. Two recovered at final allowed attempt4.

Remaining JpFhmu6jpB8:3 attempts used; fourth earliest2026-10-05 13:24:38 local, outside first window. Resume at registered2026-10-05/18:23, corrected LOCAL code only. No fifth attempt, immediate retry, same-IP library storm or failed cloud workload repetition.

Source UI checks:five caption strata, matching cue counts, three boundary text hashes and displayed-second alignment. UI integer seconds/no cue end =>250ms fidelity INCONCLUSIVE. Temporary exports deleted. Second window and exact fidelity remain required before Gate0 PASS.

Latest checks:Gate0 contracts24/24 PASS;Python6/6 PASS;tools typecheck PASS;targeted lint PASS;git diff --check PASS. Recovery Preview deleted. Detailed current state:docs/verification/gate-0/runtime-recovery.json and REPORT. Local availability/capacity UNKNOWN. Gate0B/C NOT_RUN;CP-1.7/1.8 pending;Stage01 DoD unmet;no final Stage01 commit.
