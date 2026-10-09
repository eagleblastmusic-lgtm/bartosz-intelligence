# Real production capacity observation

The collector is prepared. This document does not start observation or assert Gate C PASS. Start Stage 05B on the complete application/release candidate used with real channels and backlog. Human-quality and other unresolved gates remain separate.

The local credential `LOCAL_TELEMETRY_WORKER_CREDENTIAL` must identify the owner's dedicated PROJECT worker. It grants metadata observation, not permission to generate Gemini results. Keep its value in the local `.env` only.

Prepare that identity with the existing deployment command `tools/deployment/prepare.mjs telemetry-worker`, using the locally authorized Cloudflare account and `.env`. It persists the private recovery value before the D1 hash and verifies both copies. Existing revoked, mismatched or broader identities require explicit recovery; the command never rotates them implicitly. Provisioning does not start observation.

```powershell
$env:PATH="$PWD\.tools\node-v24.21.0-win-x64;$env:PATH"
& .\.tools\node-v24.21.0-win-x64\node.exe --import tsx --env-file=.env tools/gates/capacity/collect.ts config/capacity-collector.json .local/capacity-observation --watch
```

The first run writes an immutable START/config hash. Later runs require the same hash and append a chained observation; never reuse a directory with a different configuration. Without `--watch`, the command records one bounded sample. A complete sample requires every page at the same cut and sampled timestamp. Snapshot changes, network failure, malformed fields and exhausted page bounds produce PARTIAL evidence, never complete coverage.

Responses are limited to 256 KiB per page, at most 50 cases per page and the configured page count. Only the telemetry field allowlist is retained; exception bodies and authorization headers are excluded. Every watch cycle runs serially and waits the configured interval after the preceding cycle. SIGINT/SIGTERM interrupt waiting and current HTTP reads; an interrupted read is recorded as PARTIAL/COLLECTOR_STOPPED. HTTP 401/403 records PARTIAL and exits 78 instead of repeatedly using a denied credential.

Keep observation evidence immutable and evaluate the required real windows with `tools/gates/capacity/evaluate.ts`. Missing elapsed time remains OBSERVING / NOT_YET_MATURE. Do not substitute synthetic process tests, peak quota values, guessed remaining capacity or an idle collector for real application use. A running collector alone does not qualify source completeness, provider quality, costs, outage recovery or saturation.

The Windows task `Bartosz Intelligence Capacity Observation` is now installed.
`tools/deployment/install-capacity-cadence.ps1` registers hourly and owner-logon
triggers; `run-capacity-cadence.ps1` runs a single bounded sample under a mutex.
The task uses the pinned local Node/toolchain, a hidden window, Limited privileges,
IgnoreNew and StartWhenAvailable. Use `-Check` on the launcher to validate local
configuration without collecting data. Avoid running a second `--watch` alongside
the task. The computer must be powered on and the owner logged in; missed hours
are not manufactured. Preserve the existing chained observation directory.

2026-10-09: an actual account-wide D1 daily read limit blocked further production
queries. PARTIAL/failed samples do not qualify the observation window. The free
limit resets at 00:00 UTC; no paid fallback is enabled. A 53-case complete sample
still represents one approved source, not the required 20-channel qualification.
