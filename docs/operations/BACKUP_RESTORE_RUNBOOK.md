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

Standalone Windows restore now verifies a protected owner/SYSTEM-only ACL on
`.local/backups` before creating database bytes. Recovery targets must remain
under `.local`; reparse points in the target ancestry are rejected. ACL failures
stop restore without exposing PowerShell diagnostics. An actual restore of
backup `5a30668c-f9f2-4aae-b965-b9e15dc9c073` passed: 4678 rows, 15587643 canonical
bytes, integrity/FK PASS and zero restored active sessions/worker credentials.
Read-only checks confirmed owner/SYSTEM-only access on the directory, restored
SQLite file and private recovery locator. This closes a concrete gap where the
standalone restore previously relied on inherited directory permissions.
Targeted ACL/restore regressions passed 4 tests; one non-Windows-only test was
skipped on Windows. Scoped lint and tools typecheck passed. No production data
was replaced and no new production backup was required.

Canonical restore additionally reads back every persisted row in bounded pages
and compares SHA-256 values against the exact recovery plan. This includes all
immutable content, reference/pointer sets and intentional auth/lease changes;
counts and FK alone cannot qualify the result. A regression corrupts an actual
inserted audit value in isolated SQLite while keeping counts and FK valid, and
restore correctly fails with RESTORE_CONTENT_MISMATCH.
The existing production copy was restored into a new protected isolated target:
4678 rows / 15587643 canonical bytes, canonical_readback/integrity/FK PASS,
zero revived sessions/worker credentials. The related restore/Knowledge/backup
suite passed 8 tests before the additional corruption regression; the final
standalone restore suite passed 3 tests. Scoped lint and tools/Workers typechecks
passed. Source data and the deployed D1 were not changed.

For a second independent local rehearsal without overwriting the first target,
the restore command accepts `--target-directory .local/<new-private-directory>`.
Windows requires a descendant of `.local`, rejects reparse ancestry and applies
the same private ACL. Existing target databases are always rejected. No directory
option authorizes replacement of production or an existing restore.

Before any production replacement, identify the concrete target, retain the current
validated copy, stop writers and invalidate sessions/credentials. Production
replacement needs an owner decision because it discards newer target state.
Do not infer permission to overwrite production from a successful local drill.

## Qualification boundaries

### Local automatic cadence

`tools/deployment/install-backup-cadence.ps1` installs the owner-interactive,
limited-privilege Windows task `Bartosz Intelligence Verified Backup`.
It checks hourly and at owner logon, runs only when the newest verified copy is
at least 24 hours old, and catches missed checks when the owner is available.
`-Check` inspects registration; `-Remove` unregisters only this task and preserves
all existing copies. The launcher also supports `-Check` without mutations.

Freshness requires a successful private readback, independent SQLite restore,
integrity/FK checks, a nonfuture receipt timestamp, and an existing private file
whose SHA-256 matches the receipt. A failed, incomplete, missing or corrupted
copy cannot postpone backup. The runner reuses the existing portable backup
and restore implementation; it never forwards child diagnostics or private data.
Exclusive task scheduling and a local process mutex prevent overlapping cadence
runs. Failed attempts remain due and can retry at the next check. Nothing is
deleted automatically; monitor disk space and preserve validated recovery copies.

Actual installation and read-only verification passed. The existing verified
copy matched its hash and was FRESH, so no redundant backup/barrier ran.
Three targeted cadence tests passed, as did tools typecheck, scoped lint and
both PowerShell parser checks. A full due scheduler execution remains NOT_RUN;
the existing backup/restore acceptance is reused, not relabeled as a scheduled run.
This task requires this computer, the signed-in owner and valid Cloudflare
authorization. It cannot guarantee a 24-hour RPO while the machine is offline.

A copy on this computer is not an independently verified medium. Keep Drive wrapping
key recovery separate according to `DRIVE_OFFLINE_AUTH.md`; key recovery does not
replace a canonical database copy. Actual Drive token recovery needs a completed
offline grant and its separate test.

The administrative D1 REST drill does not measure Worker CPU. A production-size
Worker path, independent-medium recovery, observed automatic backup execution and
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
