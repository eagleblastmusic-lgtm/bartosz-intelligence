# Operator runbook

Use the existing owner account at
https://bartosz-intelligence.eagleblastmusic.workers.dev.
Keep credentials in local `.env` and deployed secret bindings. Never copy tokens,
authorization headers, source bodies or database dumps into diagnostics.
Paid services remain disabled; no recovery procedure enables billing or fallback.

## Diagnose before retry

Open System and inspect component state, freshness, job reason, next eligible
attempt and local worker heartbeat. Distinguish an offline executor or stale
quota observation from a failed provider. Retain job/run identifiers and fixed
reason categories. Verify the latest deployment receipt and current migration
ledger before attributing a failure to a different application version.

If the local transcript executor is offline, intake stays in the durable Core
queue. Start or inspect it with `tools/executor/start-services.ps1` / `-Check`.
The logon task and scoped credentials are described in
[LOCAL_EXECUTOR_RUNBOOK.md](LOCAL_EXECUTOR_RUNBOOK.md). Do not register a new
worker or rotate credentials merely because the process stopped. After restart,
check heartbeat and backlog progress; expired lease/fence recovery prevents
late candidates from becoming accepted results. No heavy Edge caption fallback.

For temporary provider/transport failure, retain the existing durable job and
its retry policy. Do not recreate it, edit arrival timestamps, force SUCCEEDED
or clear fences. A revoked credential requires explicit reauthorization, not a
restart loop. Malformed/refused/truncated AI results stay unaccepted and cannot
be treated as READY. The bounded repair policy does not authorize repeated live
requests beyond admission or the owner's material-specific authorization.

## AI quota and compatible rollback

Gemini Free is the only implemented active pipeline. Unknown/stale remaining
quota requires a fresh official observation; 28-day peak usage is not today's
remaining allowance. Do not assume usage zero, bypass reservations or run a live
request blindly. Expired eligibility and missing quality approval must be
resolved with evidence rather than SQL status edits.

Prompt publication uses the existing Studio preview/confirmation flow and
immutable revisions. A provider/model change requires compatible wire/schema,
purpose/region eligibility and actual quality evidence. Preserve accepted runs
and selection history. Do not mutate published prompt snapshots or switch to
an unimplemented provider. With no qualified compatible replacement, leave new
analysis deferred and preserve collected source data and existing knowledge.

The concrete preview/confirmation and immutable-revision procedure is in
[MODEL_PROMPT_RECOVERY.md](MODEL_PROMPT_RECOVERY.md). It does not claim an actual
model promotion or authorize additional live requests.

## Drive reconnect, retry and conflict

Open System → Connections. Reconnect the existing Drive connection after
authorization failure; verify and confirm its retained private root. Do not
create another root for a transient failure. OAuth publishing must reflect the
grant issuance lifecycle; a refresh alone does not promote an old Testing grant.
See [DRIVE_OFFLINE_AUTH.md](DRIVE_OFFLINE_AUTH.md) for actual receipts and bounds.

Export status exposes retry reason/count and pause. Ordinary retry uses the
existing file identity and settings revision. It cannot resolve manual edits.
Inspect a conflicted file, preview its current state and explicitly preserve the
manual version when appropriate. This pauses that day's application updates;
Core intake and knowledge remain intact. Do not overwrite manual content,
reset file IDs or adopt a similarly named unrelated file.

Automatic export remains disabled until its actual acceptance scope qualifies.
Disconnect removes the application's local credential while preserving mappings
and files; it does not revoke Google's account grant. Broadening Drive scopes,
sharing folders publicly or replacing a missing committed file is not a repair.

## Backup, restore and migrations

Use [BACKUP_RESTORE_RUNBOOK.md](BACKUP_RESTORE_RUNBOOK.md). The local backup task
checks freshness and verifies private copy hashes; inspect its registration and
latest receipt. Failed backups do not qualify recovery. An offline computer or
expired Cloudflare authorization can prevent the schedule; monitor these states.
An on-host copy is not independent physical recovery media.

Restore first into a new isolated database. Verify hashes, canonical references,
migrations, FK/integrity and rebuilt projections. Restored active sessions and
worker credentials must not revive; requalify authorization/root access.
Replacing production discards newer state and requires a concrete owner decision.
Append migrations, verify ledger hashes and retain a pre-upgrade verified copy;
never edit applied SQL or use synthetic fixtures as production data.

## Acceptance and remaining owner decisions

Use [RELEASE_VERIFICATION.md](RELEASE_VERIFICATION.md) and hash-bound actual
receipts. Passing local tests does not prove actual provider quality, consumer
capability, full outage RPO/RTO or a mature capacity window. Keep implementation
completion separate from formal production acceptance.

Per the explicit owner amendment, CP-3.13 independent human review remains
AWAITING_HUMAN_REVIEW and Gate U manual screen-reader remains NOT_RUN / DEFERRED.
Continue independent technical work without repeatedly asking for these forms.
Automated axe, keyboard, quality/Evidence and E2E checks stay required. Multi-day
Gate C observation remains separate and must use real application work; do not
manufacture PASS or pause development to wait for elapsed days.

Confirmed D1 free daily quota is an account-wide service limitation. Queries can
fail through both REST and Worker bindings; `/health` alone does not prove usable
Core. Preserve data and existing backup receipts, allow the daily reset at
00:00 UTC, and verify a new capture before claiming freshness/RPO. Keep
`paid_services_enabled=false`. The current redacted incident and scheduled
cadence state are recorded in `RELEASE_READINESS_REPORT.md`.
