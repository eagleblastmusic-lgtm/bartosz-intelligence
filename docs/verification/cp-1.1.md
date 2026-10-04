# CP-1.1 evidence

Date: 2026-10-04. Environment: Windows x64, PowerShell.

Initial directory contained only `Plan/`, no Git repository, no handoff or application.
Git initialized on `main`; no remote configured. Owner materials were not modified.
The start prompt was absent from Plan; the owner-mentioned Downloads copy was read.
Master SHA-256 matched the index:
`587d082647ffdc4ba9fd9d23f4163f428746d2bf7b4bc9544e7916f6d38823ed`.

Passed: root lint, format check, all five workspace typechecks and builds,
Node tooling typecheck; all three deliberate negative controls in
`tools/toolchain-boundaries.ts` rejected their fixtures (Worker Node import,
unused variable, malformed formatting). Fixtures were removed in finally blocks.

Clean source copy `.local/clean-cp11`: frozen install and second build passed,
with identical web asset name `index-BKnrB5Nx.js`. No incompatible peer warnings.
Node ZIP hash checked against the official release SHASUMS256 list before extraction.
Explicit `allowBuilds.esbuild=true` resolves the initial ignored-build failure.

Sandbox npm initially returned ENOTCACHED and ECONNREFUSED; approved execution
outside the sandbox fetched dependencies. Windows child process and pnpm global
operation-lock restrictions also require approved execution in this host.
No paid APIs or cloud resources were used.

Official sources consulted: [Node release](https://nodejs.org/en/download/archive/v24.21.0),
[pnpm installation](https://pnpm.io/installation),
[Cloudflare integration](https://developers.cloudflare.com/workers/testing/vitest-integration/).
Exact package metadata and peer requirements were read from the public npm registry.
Current Vitest 5 and TypeScript 7 were not selected: this bundle uses supported
Vitest 4.1 and TypeScript 6, consistent with the stage defaults.
