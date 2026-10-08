# Portable backup format 2

Measurement trigger: the verified private pre-deployment SQL copy recorded in
`docs/verification/deployment/2026-10-08T11-29-12.423Z-pre-upgrade.json`
contains 11,954,905 bytes. The existing portable pilot limit is 2 MiB.
Master §23 and Stage 07 CP-7.10 permit a measured backup size extension.
This changes implementation capacity, not canonical Intelligence architecture.

Format 1 remains the default: 64,000-byte chunks, 2 MiB total, 200 chunks,
120-second mutation barrier. Its limits and rejection criteria remain intact.
Format 2 requires an explicit owner request: 128 KiB chunks, 32 MiB total,
2,048 chunks, a fixed maximum 600-second barrier. It has no indefinite renewal.
Migration 033 pins the format on each snapshot and prohibits format changes.
Hash, counts, cursor continuity, owner boundaries, secret exclusion, restore
fences and independent-medium requirements are unchanged.

Validation scope: a synthetic canonical corpus exceeding the measured 11.95 MB
copy, real local SQLite restore, D1 barrier and immutable-format regressions.
These are correctness checks, not production CPU qualification or an RPO/RTO
claim. A live complete portable-copy/restore drill remains required before
claiming production qualification at this size. SQL-copy verification already
exists independently and remains available.

Rollback: omit `format_version` (or request 1) for future pilot backups. Existing
version 2 copies require a version 2 reader; do not relabel or silently truncate.
No paid service or additional storage subscription is enabled.
