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
No remote resources, provider calls or deployment exist in this checkpoint.
