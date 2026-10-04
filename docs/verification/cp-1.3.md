# CP-1.3 evidence

Date: 2026-10-04. LOCAL runtime only; no cloud deployment or account eligibility inferred.

Exact runtime: Wrangler 4.147.0, workerd 1.20261001.1,
Cloudflare Vitest plugin 1.3.6, Vitest 4.1.11, Playwright 1.63.0,
Chromium 153.0.8010.12. `compatibility_date=2026-10-01`; no nodejs_compat flag.
Installed Workers types use `Cloudflare.Env` augmentation, despite documentation
showing ProvidedEnv. Tests use the actual package interface and message attempts.

Full local CI command sequence passed from a clean source export at
`.local/clean-cp13` with no node_modules or built Assets initially:
frozen install, lint, format:check, typecheck, verify:config, verify:migrations,
build, test:unit (22), test:contract (4), test:workers (6), test:e2e (1).
33 tests passed, none failed/skipped in this final sequence. Browser test 7.5 s.
No incompatible peer dependency warnings. Web is built before Worker Assets bundling.
Worker bundle 59.01 KiB, gzip 14.94 KiB; this is not a CPU measurement.

Worker tests prove D1 insert/read, failed-batch rollback, fixture reconstruction,
per-test-file storage isolation, Queue producer and retry state, health with/without
bindings, and API JSON 404. Browser proves real same-origin shell, SPA fallback,
health and API separation through Wrangler local. The initial browser startup
failure exposed a non-handler named value export; removed and retested successfully.

Production migrations NONE, next free number 001. Ledger is empty; verification
checks filename, hash, dependency order, empty SQL and unchanged applied records.
Contract tests exercise fresh/upgrade validation and rejection. D1 restore test
uses disposable fixture rows, not a claim about production backup/restore.
Local IDs are fixtures, not real resources. No secrets needed in build or CI.

Hosted GitHub Actions NOT_RUN: no remote and no push authorization. The checked-in
workflow mirrors the complete successful local pipeline; hosted execution is not
reported as evidence. It has no scheduled compute, deployment, secrets or live gate.

Lockfile SHA-256: `82dcb2d166b22f747f89ee72c654f3204ef75b13ec1d037d387dc23e5182dc85`.
Defaults SHA-256: `398b6d3987fc7f6a0452b5ebb6a7dfe1f77582b4a65c01f5d0730f86e3cb4207`.
Architecture deviations NONE. Gate E/0/CPU/0B/C NOT_RUN.
