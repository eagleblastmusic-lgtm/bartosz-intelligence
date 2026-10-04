# Bartosz Intelligence

Stage 01 bootstrap only. The canonical inputs in `Plan/` remain read-only and
are excluded from Git because they were provided by the owner outside the repo.

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
No remote resources, provider calls or deployment exist in the local bootstrap.

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
Production migrations are NONE; `db/fixtures/smoke.sql` is test-only.
