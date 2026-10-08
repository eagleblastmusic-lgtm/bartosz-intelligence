# Backup and restore

Run commands from the repository root using the pinned Node runtime. Keep `.env`
local. Never paste its values, SQL dumps or portable JSON into logs, Git or chat.
The administrative commands require the existing Cloudflare account authorization.
No billing, additional provider or subscription is needed.

## Canonical portable drill

```powershell
$env:WRANGLER_SEND_METRICS = 'false'
$env:CLOUDFLARE_ACCOUNT_ID = '0db26be1cc4c4f7f196d5ac401e232f3'
& .\.tools\node-v24.21.0-win-x64\node.exe --env-file=.env --import tsx tools/deployment/portable-backup.ts
```

This is an explicit administrative operation. It acquires a fixed ten-minute
mutation barrier for format 2, reads owner-scoped canonical chunks, verifies the
manifest and private-copy readback, and restores into an empty local SQLite
database. Reads remain available; writes resume after completion, abort or expiry.
No active session or reusable worker credential is restored. A temporary internal
owner session is revoked on exit; neither its value nor the owner subject is printed.

Private files are in `.local/portable-backups`, protected for the current Windows
owner and SYSTEM. Receipts in `docs/verification/backup` contain only counts,
hashes, timestamps and fixed diagnostic categories. The SQL export fallback is
`tools/deployment/pre-upgrade-backup.mjs`; it independently imports the selected
ordinary tables and rebuilds derived FTS before migration rehearsal.

Format 1 remains the default on the owner API. An explicit `format_version: 2`
request selects the larger bounded format. Limits and the measurement trigger are
documented in `docs/decisions/BACKUP_SIZE_ACTIVATION_2026-10-08.md`. Do not alter a
manifest version to bypass a rejection. Oversize rows or expired barriers require
diagnosis; an incomplete copy is not a verified recovery artifact.

## Offline restore of an existing portable file

```powershell
& .\.tools\node-v24.21.0-win-x64\node.exe --env-file=.env --import tsx tools/db/restore-core.ts '<absolute private backup path>'
```

`GOOGLE_OIDC_OWNER_SUBJECT` must be present locally and match the hashed binding in
the backup. This command creates an isolated target under `.local/backups`, rejects
an existing target, validates migration receipts and chunk chains, and checks
integrity and foreign keys. It does not replace the deployed D1 database.
The recovery locator records where the validated copy and isolated restore reside;
writing that locator does not prove an independent medium.

Before any production replacement, identify the concrete target, retain the current
validated copy, stop writers and invalidate sessions/credentials. Production
replacement needs an owner decision because it discards newer target state.
Do not infer permission to overwrite production from a successful local drill.

## Qualification boundaries

A copy on this computer is not an independently verified medium. Keep Drive wrapping
key recovery separate according to `DRIVE_OFFLINE_AUTH.md`; key recovery does not
replace a canonical database copy. Actual Drive token recovery needs a completed
offline grant and its separate test.

The administrative D1 REST drill does not measure Worker CPU. A production-size
Worker path, independent-medium recovery, automated 24-hour backup cadence and
full outage RPO/RTO remain separate qualification work. RPO 24 h and RTO 4 h are
targets, not achieved SLA. Gate C maturity and Gemini quality acceptance are also
independent of a passing backup integrity check.

The drill records separate backup, isolated restore and total elapsed durations.
These durations do not qualify a full application outage RPO/RTO. The current
restore target remains a new local SQLite file, never the deployed D1 database.

On 2026-10-08 the first concurrent-service backup attempt failed in CHUNKS:
`docs/verification/backup/2026-10-08T18-16-04.165Z-fail.json`. Its incomplete copy
was not verified. The serial REST path performed repeated barrier lookups and
separate page/receipt requests for every chunk. The correction combines the
snapshot/permit lookup, batches independent page/receipt reads and atomically
guards receipt insertion/readback against the current database barrier. The
barrier duration and acceptance criteria remain unchanged. Expiry immediately
before receipt commit is tested and cannot persist a chunk. Backup/restore and
related recovery regression verification: 10 tests passed.

The subsequent bounded retest failed with CLOUDFLARE_TRANSPORT_FAILED after
184 chunks, recorded in
`docs/verification/backup/2026-10-08T18-23-24.321Z-fail.json`. The generic
administrative REST client still does not replay ambiguous mutations. The backup
drill now retries an immutable (backup/table/cursor) chunk at most once after a
transport/response/selected 5xx failure, while its original barrier remains valid.
An ambiguous final completion is reconciled by reading the verified manifest;
another completion is allowed only when readback proves BACKUP_NOT_VERIFIED.
Unavailable reconciliation, expiry, permission and integrity failures stop the
drill. This recovery changes no acceptance threshold or barrier duration.
Recovery/client/barrier regressions: 17 tests passed.

The corrected real-production retest passed:
`docs/verification/backup/2026-10-08T18-39-53.489Z.json`.
It captured cut 1593 with 35 migrations, 4678 canonical rows and 364 chunks;
private-copy readback, independent empty SQLite restore, integrity and foreign
keys passed. Backup took 379516 ms; isolated restore took 4698 ms. No active
sessions or worker credentials were restored. Independent physical medium and
full application RPO/RTO remain unqualified.
