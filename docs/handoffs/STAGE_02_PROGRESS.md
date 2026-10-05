# Stage 02 progress

Status: IN_PROGRESS

Start: Stage 01 DONE / GO, clean 56a8183. Owner execution amendment recorded in docs/decisions/OWNER_EXECUTION_AMENDMENT_2026-10-05.md; canonical Plan/Master unchanged.

CP-2.1: local exit PASS; evidence docs/verification/cp-2.1.md. Auth primitives and runtime checksum ledger implemented. Migration map: identity/config → 001_identity_config.sql; exact checksum in db/migration-ledger.json; next number 002. Schema applied only in local test/verification databases. Production schema NOT_APPLIED. Runtime migration bootstrap is administrative and is not a worker endpoint.

CP-2.2: PASS; evidence docs/verification/cp-2.2.md. Migration source/items → 002_sources_items.sql; checksum/dependency in ledger; next 003.

CP-2.3: PASS; evidence docs/verification/cp-2.3.md. Jobs/outbox → 003_jobs_outbox.sql; exact checksum in ledger; next 004.

CP-2.4: PASS; evidence docs/verification/cp-2.4.md. Runs/registry/export skeleton → 004_runs_registry_exports.sql; exact hash in ledger; next 005.

CP-2.5: PASS; evidence docs/verification/cp-2.5.md. Bounded cron recovery, durable Outbox and scoped local pull. Migrations unchanged; next 005.

CP-2.6: PASS; evidence docs/verification/cp-2.6.md and immutable core-source live JSON. Operations/scan-intent schema → 005_operations_snapshots_backup.sql; exact hash in ledger; next 006. Operational behavior/backup remain CP-2.10.

CP-2.7: PASS; evidence docs/verification/cp-2.7.md. Scan membership/bounded page staging → 006_discovery_scan_members.sql; exact hash in ledger; next 007. Uncreated Stage 03 migration numbers must follow actual map.

CP-2.8: PASS local; evidence docs/verification/cp-2.8.md. Scheduler/overlap/missing intents/30-day metadata refresh. Migrations unchanged; next 007.

Current checkpoint: CP-2.9 — owner/worker API contracts LOCAL_API_VERIFIED (docs/verification/cp-2.9-api.md), live auth/onboarding IN_PROGRESS (docs/verification/cp-2.9-bootstrap.md). Owner confirmed client creation and authorized deployment/bootstrap; this revokes the earlier live-test pause. Control plane is deployed at the fixed config/application.json origin with new owned D1/Queue in config/deployment.json. Seven remote checksummed migrations applied, remote quick_check/FKs PASS. Secure owner bootstrap → 007_owner_bootstrap.sql; next 008. 162 local tests PASS, typecheck/lint/build PASS. The owner must finish Google account selection/consent; subject is not guessed or exposed. A bound grant rejected repeat submission; a separate bounded HTTP probe returned 303 Google redirect and cookie, and was retired. New grant/launcher guards double submission. Current owner count remains 0; live OAuth/session PASS is not yet claimed. Session signing secret generated privately; no value logged or committed.

Control-tick supports guarded continuation and <=50-query four-item chunks, but actual deployed automatic consumption is pending. Generic transcript/AI completion remains unavailable until Stage 03 validator. CP-2.10/11 backup/full recovery evidence is still outstanding. No completed Stage 02 claim. Existing YouTube and Gemini keys are present; paid services remain disabled. No caption workload or paid model call deployed. Current subscriptions API remains 403/UNKNOWN, reuse actual Stage 01 Free account eligibility without rerunning benchmarks.

Required context on resume: index, Stage 02 plan, Stage 01 completion, this progress, current Git/migration ledger and CP evidence. Reuse Stage 01 gates. Do not load later stage plans yet.

Launcher correction: Chromium CSP blocked the initial POST redirect to accounts.google.com after binding the grant. Fixed the actual form-action destination allowlist. Isolated real-browser negative control reproduces the old failure; fixed policy performs one POST then one GET without forwarding capability/body. Evidence: docs/verification/cp-2.9-bootstrap.md; tool tools/gates/bootstrap-browser-repro.mjs. New private grant/launcher ready for owner; callback remains pending, not PASS.
