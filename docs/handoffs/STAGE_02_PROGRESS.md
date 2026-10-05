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

Current checkpoint: CP-2.9 — owner/worker API contracts LOCAL_API_VERIFIED (docs/verification/cp-2.9-api.md), live auth/onboarding pending. 159 local tests PASS, required local checks PASS. Control-tick supports guarded continuation and <=50-query four-item chunks, but actual deployed automatic consumption is pending. Generic transcript/AI completion remains unavailable until Stage 03 validator. CP-2.10/11 backup/full recovery evidence is still outstanding. No completed Stage 02 claim. Actual owner Google OIDC smoke is explicitly paused until owner confirms client creation and local configuration: GOOGLE_OIDC_CLIENT_ID, GOOGLE_OIDC_CLIENT_SECRET, GOOGLE_OIDC_OWNER_SUBJECT, APP_ORIGIN. Exact origin/callback/client name are recorded in config/application.json; production is NOT_DEPLOYED. SESSION_SIGNING_SECRET will be provisioned privately; no secret value requested in chat. Existing YouTube and Gemini keys are present; paid services remain disabled.

Required context on resume: index, Stage 02 plan, Stage 01 completion, this progress, current Git/migration ledger and CP evidence. Reuse Stage 01 gates. Do not load later stage plans yet.
