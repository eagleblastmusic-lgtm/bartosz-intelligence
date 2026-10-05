# Stage completion handoff

Stage: 02 / 02_V1A_CORE_CONTROL_PLANE.md
Status: READY_FOR_VERIFICATION
Date: 2026-10-05T21:45:00Z
Final commit/tag: PENDING final real reference completion

## Implemented

CP-2.1–2.10 complete; CP-2.11 combined recovery passes, final public reference completion pending. Cloudflare D1 is the canonical authority; Queue messages are expendable hints. Owner Google OIDC, one-use bootstrap and fixed issuer/subject allowlist are live. Sources, Channels, immutable Item revisions, durable jobs/attempts, outbox, acceptance fence, registry/export skeleton, discovery/reconciliation and canonical private backup/restore are implemented. Cloud control intake continues while local executor is offline. Transcript and AI production execution are intentionally not certified by Stage 02.

## Files/modules created

Core modules: `packages/core/src/auth`, `db`, `jobs`, `sources/youtube`, `backup`; shared contracts in `packages/contracts/src`. Hono auth, owner source/item/job/system/backup APIs and scoped internal worker API in `apps/api/src`; same-origin React owner login/onboarding/download in `apps/web/src`. Production provisioning/deployment in `tools/deployment`, isolated restore in `tools/db`, bounded live reference in `tools/gates/core-reference.ts`. Detailed checkpoint records are `docs/verification/cp-2.*.md`; private bootstrap/backup runbooks are under `docs/runbooks`.

## Database migrations

Checksummed append-only map is authoritative in `db/migration-ledger.json`, version 1. Applied locally and remotely: 001 identity/config; 002 sources/items; 003 jobs/outbox; 004 runs/registry/exports; 005 operations/snapshots; 006 discovery page staging/membership; 007 owner bootstrap; 008 backup barrier. Next migration number: 009. Historical SQL is immutable. Fresh install, checksum mismatch/repeat guards, isolated canonical restore, integrity and foreign keys PASS. 006–008 extend the original planned 001–005 without renumbering or rewriting them. Exact hashes remain in the ledger and deployed applied_migrations.

## API/contracts introduced

Owner `/api/v1/auth`, `/sources`, `/items`, `/jobs`, `/system/summary`, `/backup` require live signed session, owner SQL/FK scope, and Origin/CSRF for mutations. Listing uses signed owner/filter-bound keyset cursors, limits at most 50. JSON input bounded at 64 KiB; unknown fields and forged cursors/IDs fail closed. Worker `/internal/workers` requires independently hashed, task-scoped and unrevoked identity: lease/start/heartbeat/retry/defer, controlled discovery completion/control tick. Worker credential cannot authorize owner browsing or backup. Generic transcript/AI completion is unavailable until Stage 03 installs validators.

Canonical task types/states/LeaseToken and QueueSignal live in `packages/contracts/src/jobs.ts`. Dedup includes input/profile/prompt/routing/schema/enrichment snapshots and explicit run nonce. Retry does not regenerate nonce or change arrival_origin_at/origin_kind. Four fast jittered retries then deferred recovery; actual quota reset is required, unknown reset remains explicit. Cloud lease 5 minutes, local lease 15 minutes, monotonic fence. Worker revocation prevents lease renewal and acceptance.

## Tests

Passed: 37 files / 177 unit, contract and real workerd tests; typecheck/lint/format/build; eight-migration fresh/restore verifier; three Chromium GUI E2E tests. Combined recovery and canonical backup/restore are included. No unresolved failed required local tests. Historical failures and root causes remain in checkpoint evidence, including OAuth workerd redirect constructor incompatibility, launcher CSP, fixture selection/scope/signature and browser-cache lookup. Stage 01 live benchmarks were not repeated.

Skipped: production AI/transcript output, later UI/Knowledge/Drive, large-corpus capacity calibration and long-run Gate C are outside this stage. Browser post-download screenshot NOT_RUN after browser extension became unavailable; the actual downloaded file and independent restore receipt establish the backup medium instead.

## Runtime verification

Actual origin: `https://bartosz-intelligence.eagleblastmusic.workers.dev`, fixed server callback `/api/v1/auth/callback`. Owner completed real Google login; subject was privately pinned locally and deployed. Secrets are present only in private environment/deployment files. Narrow control identity scopes are DISCOVER/RECONCILE. Automated Queue/cron advanced real TED discovery and retained 50 transcript intents while local execution was absent. Reference exact window: 2026-09-05T21:05:07.309Z through 2026-10-05T21:05:07.309Z; independent all-page reference 117 pages / 234 metadata requests / 50 video IDs / zero unknown dates. Final COMPLETE equality is recorded separately before marking DONE.

Live private backup `68e7e814-6fce-44ca-b233-c006286cfdfa`: 1501 rows, 518696 row bytes, restore integrity/FK PASS, zero active restored sessions/credentials. Actual private file in Downloads and recovery locator/database in ignored `.local/backups`; no canonical payload or secret values committed. Backup manifest contains cut_seq/counts/hashes/migration ledger; a two-minute SQL barrier prevents concurrent canonical writes and an expired/incomplete cut cannot become VERIFIED. Pilot limits are 200 chunks / 2 MiB, not large-corpus qualification. Details: `docs/verification/cp-2.10.md`.

## Architecture deviations and process amendments

No Master rewrite. Owner amendment `docs/decisions/OWNER_EXECUTION_AMENDMENT_2026-10-05.md` separates Stage 05A preparation from 05B real observation and permits 06/07/08 development before multi-day maturity. Paid services remain false with no paid fallback. Stage 01 provider selection and qualified-runtime remain authoritative: local yt-dlp PRIMARY, Cloudflare control plane, Gemini 3.8 Flash Free profile. Execution location and AI profile must remain independent axes.

## Known issues and deferred items

Stage 02 GUI is minimal onboarding, not the full Stage 04 interface. FETCH_TRANSCRIPT backlog is intentionally durable until Stage 03 local executor is installed. Control workload has local query-budget proofs at most 50 statements and real live progress, not a global CPU/capacity qualification. Account remaining quota, DB storage/operations and Queue metering are UNKNOWN unless explicitly sampled; never interpret unknown as zero or healthy. Gemini generation was not invoked here. Backup export/restore must expand with later canonical tables; Drive automation and production activation of a restored database belong to later stages. The bound pilot format is not an unlimited backup promise.

## Measurements and guarantees for next stage

Summary exposes task/state/origin counts, oldest arrival, due/expired leases, Outbox backlog/oldest due, source complete watermark, worker availability and quota freshness; service rate remains null/NOT_CALIBRATED. Discovery follows all uploads cursors, uses videos publication metadata, preserves unknown dates, never exits at first old/known ID, has bounded durable staging and independent RSS/head/full/weekly paths. Only all-page/item/job completion advances full watermark. Gap overlap, cursor expiry, partial failure and metadata refresh boundaries are tested.

Acceptance is a shared guarded D1 batch: initial current job/attempt/credential/lease/fence permit nonce and captured commit time guard every accepted write; zero-row permit produces zero accepted effect even when batch succeeds. Active selection is separately revision/CAS guarded; historical late runs cannot override a newer request. SUCCEEDED is last; PROJECT/outbox remain separate work. Queue ack follows durable disposition; duplicate accepted result is idempotent. Combined regression proves transport loss, crash, DB rollback and stale worker retain jobs and produce one accepted effect. Stage 03 must add schema/evidence validation at this existing boundary, not expose the deterministic core fixture as a provider validator.

## Context next stage MUST load

`Plan/00_IMPLEMENTATION_MASTER_INDEX.md`; `Plan/03_V1A_TRANSCRIPT_AND_AI_PIPELINE.md`; this handoff; current repo and only Master sections specified by Stage 03 Required context. Inspect current provider-selection/qualified-runtime and shared acceptance/schema/backup contracts. No need to reload full previous plans, Stage 01 raw benchmark logs, later stage plans or full Master without an explicit trigger.
