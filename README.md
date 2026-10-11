# Bartosz Intelligence

Single-owner YouTube intelligence application: Cloudflare control plane,
durable source/analysis jobs, local yt-dlp executor, canonical evidence and
knowledge, Daily web interface and private Google Drive exports.
Implementation and production acceptance are still in progress; this README
does not declare release readiness. Paid services and automatic paid fallback
are disabled. The canonical owner plans in `Plan/` remain read-only and outside Git.

The 2026-10-11 [CI and radio audit](docs/verification/release/CI_RADIO_P0_AUDIT_2026-10-11.md)
records actual green public GitHub Actions, source-preserving radio checks and
the remaining automatic P0 requirements. Clean-checkout prompt contracts use
the exact hash-pinned public [Prompt Pack section fixture](tests/fixtures/registry/README.md).
The [one live QUALITY_TEST proposal](docs/verification/gate-ai/radio-quality-test-proposal-2026-10-11.json)
is preparation only, AWAITING_OWNER_APPROVAL; no consent or generation is
implied by build/tests. Current deployed code and new repository-only patches
are distinguished in [release readiness](RELEASE_READINESS_REPORT.md).

Use Node **24.21.0** and pnpm **12.9.1**. With the local tools downloaded for this run:

```powershell
$env:PATH = "$PWD\.tools\node-v24.21.0-win-x64;$PWD\.tools\node_modules\.bin;$env:PATH"
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
```

The pinned lockfile and explicit esbuild build permission are required. Tooling
runs on Node; API source is typechecked against workerd globals without Node types.
Installation and build do not deploy, activate billing or invoke AI providers.
Never copy production secrets into a clean-install or synthetic test environment.

Local runtime verification:

```powershell
$env:WRANGLER_SEND_METRICS = 'false'
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\.local\playwright"
pnpm exec playwright install chromium
pnpm verify:config
pnpm verify:migrations
pnpm test:unit
pnpm test:contract
pnpm test:workers
pnpm test:e2e
```

`pnpm build` builds the shell first, then bundles the Worker with dry-run only.
`pnpm dev` starts API and Vite; `pnpm dev:api` serves built Assets and API on
127.0.0.1:8787 with local persistence under `.local/worker`. The Wrangler config
contains fixture database IDs and must not be deployed as a cloud configuration.
The production target is configured separately in `config/deployment.json`.
Deployment uses `tools/deployment/deploy.mjs`; never deploy the fixture Wrangler
configuration directly. Ordered production migrations and their immutable hashes
are recorded in `db/migration-ledger.json`; `db/fixtures/smoke.sql` is test-only.

Operations references:

- [Local executor and startup](docs/operations/LOCAL_EXECUTOR_RUNBOOK.md)
- [Drive authorization, root verification and export](docs/operations/DRIVE_OFFLINE_AUTH.md)
- [Backup and restore](docs/operations/BACKUP_RESTORE_RUNBOOK.md)
- [Capacity observation](docs/operations/CAPACITY_OBSERVATION_RUNBOOK.md)
- [Release evidence evaluation](docs/operations/RELEASE_VERIFICATION.md)
- [Public bundle secret scan](docs/operations/RELEASE_SECURITY.md)

Owner Google sign-in and Drive offline consent are separate. A confirmed private
Drive folder does not enable automatic exports. The production workflow must
pass its actual provider, quality, recovery and release gates before claiming
readiness. Missing human reviews and immature long-run observation retain their
explicit states; local fixtures do not replace those checks.
