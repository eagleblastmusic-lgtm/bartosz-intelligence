# Gate R evidence protocol

`pnpm gate:r --manifest <manifest.json> --output <new-report.json>` evaluates
recorded recovery drills. It performs no injection, deployment or provider call.
Outputs are immutable (`wx`). Missing arguments and incomplete drill coverage are
NOT_RUN; malformed/hash-mismatched evidence is FAIL. A Gate R scorecard never
approves the global release or activates a pipeline.

The manifest version is `GateRManifest/1.0`, with hash-bound `configuration`,
`baseline` references and unique `cases` (`id`, `deadline_ms`, nullable `evidence`).
References use relative JSON paths within the manifest directory, bounded to
256 KiB. Traversal, external symlinks and hidden paths are rejected by the existing
evidence loader. See `tools/gates/reliability/evaluate.ts` for the exact strict
shapes; unknown fields are rejected rather than copied into reports.

`GateRConfiguration/1.0` pins the candidate and migration set, migration count,
owner pseudonym and isolated target. Target must be HTTP on 127.0.0.1 and the
isolated database identity must differ from production. Paid services must be
false. The CLI independently verifies the actual migration files and ledger and
computes the tracked application/config/tool/test fingerprint. Dirty candidate
inputs, unknown migrations and incompatible fingerprints cannot qualify.

`GateRBaseline/1.0` records the configuration hash, consistent cut, canonical
counts and origin-set hash. A claimed restore boolean alone is insufficient:
the hash-bound portable backup receipt must prove private-copy readback,
independent empty SQLite restore, integrity/FK checks, matching backup hash/cut
and migration count, with zero restored active sessions/credentials. This proves
an isolated database restore, not an independent physical medium or full RTO.

Required cases are lease crash, queue loss, discovery interruption, database
rollback, transcript failure, auth revocation, quota/local offline, malformed AI,
model/prompt rollback and Drive/consumer failure. Each `GateRCase/1.0` binds the
configuration and baseline, observed time, kind and measured invariants.
Lost jobs, duplicate effects, stale writes or paid requests force FAIL. Origins
must be preserved, recovery must complete within the preregistered deadline.
Incomplete cases remain NOT_RUN. Deadlines are drill acceptance thresholds,
not instructions to pause development or execution-resume time limits.

Local D1 cases require ACTUAL_LOCAL_D1 observations. Transcript and Drive cases
require ACTUAL_PROVIDER observations. SIMULATED evidence remains visible but
cannot qualify those cases; a passing synthetic unit fixture is not a project
gate receipt. Review the primary observations: hashes guarantee identity, not
the truth of an observer's statement. No actual Gate R PASS is currently claimed.

Failure/security files are registered in the existing Workers Vitest project
and its typecheck. The first isolated failure drill proves recovery after
26 hours without transport, preservation of original arrival/origin, rejection
of the crashed candidate's fence, one successful executor out of two contenders,
one accepted effect and idempotent repeated completion. Its synthetic Core result
does not qualify transcript fidelity or AI quality.

## Actual isolated D1 drill

`tools/gates/reliability/local-drill.ts --backup <private-backup.json>
--receipt <verified-redacted-receipt.json>` restores a verified real portable
backup into a new private local Miniflare D1. The owner binding comes from the
local environment; no credential or source content is written to evidence.
The runtime uses the installed Miniflare compatibility converter and the same
official migration parser as the Workers harness.

Candidate `eb90e2d` produced evidence in
`89dbb75f-ecd3-44f8-8d10-3553e7631255/`. Lease crash and lost transport PASS:
zero lost persisted jobs, duplicate accepted effects and stale writes; original
origins preserved, one winner out of two executors and idempotent completion.
A separate authorized CLI evaluation verified the on-disk reference hashes and
candidate pins: overall NOT_RUN because eight other cases remain unobserved.
The synthetic Core result does not qualify source fidelity or AI quality.
Targeted Workers recovery regression: 1 test PASS. Scoped tool lint/typecheck PASS.
No production mutation, AI/source provider request or paid request occurred.

Historical local failures, preserved without replacing their output:

- Initial constructor rejected legacy options in Miniflare 5 before injections.
  Root cause: harness API compatibility. Fixed using its exported official
  compatibility converter.
- `ed5a2c84-f134-4a3c-ba02-c87bea0c470a/` exercised the mechanisms but the
  strict evaluator rejected extra `file_count` and a colon in the isolated ID.
  Those receipts are NOT QUALIFIED. Fixed the serializer, retaining strict
  acceptance and rerunning the isolated drill on the corrected pinned candidate.
- `independent-report.json` in the successful drill directory records FAIL from
  sandbox `spawnSync git EPERM`, before evidence qualification. Authorized
  read-only retest is `authorized-independent-report.json`: NOT_RUN, two PASS.

Candidate `75502ea` additionally injected a SQL failure after the acceptance
guard and run update inside the D1 batch. Before retry, job state remained
RUNNING, run state CANDIDATE and attempt commit nonce null. Valid retry then
succeeded exactly once. Evidence: `b21a69ff-168f-434c-8cb5-20c991589c3e/`;
lease crash, queue loss and database rollback PASS; overall Gate R NOT_RUN.
The independent on-disk CLI evaluation confirmed the same result. Targeted
Discovery/recovery and evaluator/combined-recovery suites: 24 tests PASS.
