# CP-2.4 — fenced leases and guarded acceptance

PASS local, 2026-10-05. Migration 004 creates immutable schema/prompt/run snapshot skeletons, independent active selection CAS and export state. These are not published AI bundles or production accepted intelligence.

Lease CAS on real D1 has one winner in concurrent calls, monotonic fencing, server-time 5-minute cloud / 15-minute local TTL, scoped heartbeat and revoked/rotated credential guards. Candidate output hash is recomputed. Acceptance uses one captured commit_at and unique per-call nonce. Initial attempt permit requires exact owner/job/task/worker/fence/unexpired RUNNING state and current credential. Every accepted run, selection CAS, durable PROJECT intent, projection Outbox and final SUCCEEDED write repeats exact permit/current job guards. Final job transition is last. Ordered changes are checked; batch success alone never means acceptance. A late valid older run remains accepted history without replacing newer requested selection.

Critical proofs: initial permit zero → zero accepted rows/outbox/pointers; expired/stale completion rejected; SQL failure inserted between effects and outbox rolls back entire real D1 batch including permit; duplicate completion creates no second effect/project job; rotation invalidates already authenticated in-flight context. Five targeted D1 tests PASS. Broader unit/contracts/workerd: 22 files / 129 tests PASS. Typecheck/lint/migration checks PASS; fresh and independent empty restore integrity/FKs PASS; exact 004 hash in ledger, next 005.

Historical failure: scoped credential predicate added to start without corresponding final binding caused five local tests to fail with parameter-count error. Root cause fixed; targeted then broader suites PASS. No external/provider failure or relaxed criteria.

Deterministic completion records DETERMINISTIC_CORE_PROOF only. Stage 03 must extend this same guarded acceptance boundary after actual wire/canonical/evidence validation; do not expose this proof as AI quality PASS.
