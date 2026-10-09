# Original transcript archive — V1.1.3 verification

Owner-approved scope: private, complete acquired original-language captions in
Drive `Transkrypcje/<video_id>.md`. Polish Daily summary remains P0 and the only
film completion condition. This checkpoint does not qualify live AI → Drive or
declare production acceptance. Current receipt and code pin are linked from
RELEASE_READINESS_REPORT.md.

The existing transcript worker now preserves RAW, SOURCE_ORIGINAL, timestamp
coverage and offsets before deferring a PARTIAL source. Archive rendering reads
SOURCE_ORIGINAL and reconstructs every cue through raw offsets, preserving
Unicode, markup, blank/repeated cues and unknown timestamps. It never uses the
normalized text as the archived caption text. Missing ranges remain explicit;
AVAILABLE_FULL describes all acquired available captions, not proof of every
spoken word in the video. Original-language uncertainty is explicit.

Immutable descriptors exclude the changing acquisition clock. Their identity
includes raw-payload SHA and completeness/provenance so PARTIAL → full, changed
timestamps or changed source bytes cannot collide with a previous verified
descriptor. Unchanged retries deduplicate. The qualified yt-dlp binary version
and normalizer semantics are unchanged. Accepted legacy artifacts still work;
new identity suffixes must match across original source and maps. Local RPC
regression covers acceptance, AI preparation, owner correction and restore.
An initially incompatible equality check and D1's short LIKE-pattern limit were
found and repaired; final SQL uses exact prefix/length comparisons.

Migration 039 adds only folder identity and per-film operational archive receipt,
retry, reserved ID and fencing. One source reconciliation and one file attempt
per cron tick; no Gemini request, no per-film copy of caption bytes in new D1
tables. Pending/503/quota/ambiguous POST preserves the source and reserved ID.
An older changed source in backoff or conflict cannot monopolize reconciliation
and prevent registration of other films; each pending archive keeps its own retry.
Readback verifies full Markdown SHA, identity, parent and stable version. A
subsequent source update uses existing CAS PUT under the same file ID, completing
an interrupted older revision first. Conflicts and public content access hold
the archive and cleanup; summary delivery proceeds independently.
The scheduled tick settles Daily before starting transcript work, preserving P0
ordering and avoiding competition between both archives for the same invocation.

The new folder disables inherited permissions on creation and verifies effective
owner-only access. Existing parent, Daily and Backups sharing/IDs are unchanged.
Metadata-only inherited viewers are ignored only with both official markers,
`view=metadata` and `inheritedPermissionsDisabled=true`.
See [Google's limited-access specification](https://developers.google.com/workspace/drive/api/guides/limited-expansive-access).
The connected Drive metadata read confirmed the supplied parent ID/name and
returned owner plus anyone-reader permissions, but omitted effective inheritance
markers; this alone does not prove public content access. The connector's simple
folder-create action cannot set limited access or persist the application's
reserved identity, so it was not used to create a potentially shared folder.

Daily links the verified transcript. Cleanup requires the accepted analysis's
original source, the latest acquired verified source and a verified transcript
receipt, no pending archive, unfinished work or holds. The purge clock is at
least seven days after the later verification of summary and transcript. Late
transcript success extends the clock atomically without changing summary delivery.
Before first deletion, both files require full readback; restart rechecks their
versions. PRUNING can resume after artifact headers are removed because its
immutable archive receipt survives. Production deletion remains OFF.

Backup inventory is now 57 tables; exact legacy schemas 35–38 restore to 39.
Restore clears transcript leases and private-folder qualification, preserves
reserved IDs/hash/status, requires authentication and revalidation, and keeps
deletion OFF. Existing backup files were not rewritten or removed.

Representative read benchmark: 2,250,000 original bytes in 69 D1 chunks.
Existing generic reader makes 139 SQL calls; archive reader makes 3 using pages
of at most 64 chunks, with identical text and full/chunk SHA verification.
These are local SQL-call counts, not billed rows_read. Document size is bounded
at 32 MiB; overflow defers without truncation. Largest-document production CPU,
actual transcript archive reads/writes and 20-channel peak throughput remain
unmeasured. Gate C remains NOT_YET_MATURE; older capacity measurements retain
their own scopes. Holds or persistent AI/Drive failure can still grow backlog.
[Workers Free permits 10 ms CPU per Cron invocation](https://developers.cloudflare.com/workers/platform/limits/#cpu-time).
The local SQL-call benchmark and Node live runner cannot qualify cloud CPU or
memory. Before claiming automatic transcript delivery, record a real scheduled
invocation and its CPU/error outcome on representative captions; if it exceeds
Free limits, keep the durable source/receipt and move the expensive work to the
existing local execution path instead of enabling a paid plan. No such production
measurement is asserted here.

Verification includes fidelity/partial labels, seven-day boundary, no export,
Drive absence, bad hash, remote version conflict, partial AI, source change,
ambiguous create, process interruption/restart/retry, minimal metadata/dedup,
unregistered source denial, newly acquired unarchived source hold, restore after
purge and independent Daily/modules. Destructive tests use isolated local D1 or
SQLite, never production. Test counts, commands, hashes and chronological deltas
are in the receipt; overlapping test counts are not added together.

An overloaded parallel regression initially hit the unchanged default timeouts
in three CPU-heavy unit tests and one recovery case. Isolated recovery completed
in 2.394 seconds. The million-byte encryption roundtrip used a costly deep
matcher; native Buffer.compare still checks every byte and equal length and
completed in 0.503 seconds. No timeout or acceptance assertion was relaxed.
Final runs use one runner/file at a time and retain the failed attempts as history.

Production remains on 35 migrations. No new production D1 query/write, Drive
mutation, Gemini/model request, cleanup or backup capture occurred. Reset is
2026-10-10 00:00 UTC, 02:00 Europe/Warsaw. The latest real clock at verification
was still before reset. The first quota probe, exact 35 → 39 migration/deploy,
actual limited-access folder creation and one transcript archive remain pending.
Use the bounded tools in the current retention/D1 runbooks; no new AI is needed
for these transcript actions. A new Gemini trial still needs the separate pending
consent, and first production DELETE still needs its concrete review/approval.

The existing daily 02:05 heartbeat remains active with its earlier 38 prompt.
Its update to this scope failed automatic approval review because the Codex
account usage limit prevented review; the action was not executed. This is not
a safety rejection. No file edit or other bypass was attempted. Read the current
report/runbooks and require exact current schema instead of the stale prompt.
