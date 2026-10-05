# CP-2.1 — identity, auth primitives and migration integrity

Result: PASS (local checkpoint), 2026-10-05. Stage 02 remains IN_PROGRESS. Production login is NOT_RUN pending owner OIDC configuration; the browser/account smoke belongs to CP-2.9/2.11.

Starting state: clean HEAD 56a8183, stage-01-done. Canonical Master bytes SHA-256 match 587d082647ffdc4ba9fd9d23f4163f428746d2bf7b4bc9544e7916f6d38823ed. No Stage 01 benchmarks rerun.

001_identity_config.sql: owner allowlist, hashed sessions/worker credentials, immutable config revisions, payload-free audit events, single-use browser-bound OIDC state/nonce/PKCE intents. Runtime applied ledger rejects changed/missing/reordered applied migrations before new mutations. ConfigRepository requires authenticated owner context; forged contexts, worker broad access and cross-owner reads denied. Authentication validates real RSA signatures and issuer/audience/expiry/nonce/stable subject; signed Secure/HttpOnly/SameSite sessions, expiry/revocation, CSRF/Origin and worker rotation verified. OIDC scope is openid only; Drive grant remains separate.

Pinned Node 24.21.0 / pnpm 12.9.1 from .tools used. `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`: PASS. `vitest run --project unit --project contracts --project workers`: 18 files / 116 tests PASS. `pnpm verify:migrations`: count 1, next 2, fresh install, independent empty SQLite restore, integrity_check and foreign_key_check PASS. D1 uses permitted quick_check plus foreign_key_check; SQLite verifier performs full integrity_check. No deployment, AI or external provider requests.

Historical failures: initial default PATH selected incompatible bundled versions; corrected to documented pinned tools without dependency changes. Sandbox prevented process spawning/scanning ignored local runtime; approved local verification outside sandbox passed. Initial auth typings differed between Node/DOM/workerd; explicit portable JWK fields fixed. Migration fixture shared state corrupted subsequent tests; fixture resets corrected. D1 disallows integrity_check (SQLITE_AUTH); full check moved to independent SQLite, D1 quick_check retained. Test expiry date preceded actual 8-hour expiry; fixture corrected. No remaining failing required local checks.

Auth reference: https://developers.google.com/identity/openid-connect/openid-connect (Google signature/issuer/audience/expiry/nonce validation). Secrets values are absent from logs, evidence, source and fixture exports. Login-intent verifier is ephemeral security state and excluded from future portable backup.
