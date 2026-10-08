# Local executor operations

Run from the repository root with the pinned runtime, local `.env` and the credential for the selected task. Do not copy credential values into commands or logs.

Register a missing scoped identity with
`node --env-file=.env tools/deployment/local-worker.mjs`, adding exactly one of
`--analysis`, `--source-corrections` or `--search` for the selected service.
Default is FETCH_TRANSCRIPT; the other scopes are ANALYZE, NORMALIZE and PROJECT
respectively. Unsupported or combined flags are rejected before account access.
An existing revoked or mismatched credential requires explicit recovery; this
command never silently rotates it. Private values are saved locally before
registering their one-way hashes and are excluded from output.

Production NORMALIZE and PROJECT identities were registered on 2026-10-08.
One actual correction cycle exited successfully idle; one actual search cycle
exited successfully with progress. Registration/service isolation verification:
12 tests passed. These checks do not claim continuous availability or completed
backlog recovery.

```powershell
$env:PATH="$PWD\.tools\node-v24.21.0-win-x64;$env:PATH"
& .\.tools\node-v24.21.0-win-x64\node.exe --import tsx --env-file=.env tools/executor/run-local.ts
```

The default mode runs the qualified local yt-dlp transcript path using `LOCAL_WORKER_CREDENTIAL`. One process performs one cycle at a time. Cloud intake remains available while this process is offline; durable jobs, retries and fenced leases stay in D1. Restarting the process resumes normal admission/pull rather than recreating source requests.

`--source-corrections`, `--search`, `--analysis`, `--translation` and `--history` are separate modes with their scoped credentials. Provider modes additionally require the current qualified profile and conservative quota admission. A configured key alone does not qualify a pipeline. Paid fallback remains disabled. Do not start background analysis as a substitute for an explicitly bounded quality test.

For one explicitly selected analysis test use `--analysis --once --job-id <job_id>`. Selection never grants permission to process another job. `--once` exits after one cycle and returns a nonzero code on failure.

CLI arguments are validated before credential lookup or worker construction.
Unknown flags, duplicate modes/`--once`/`--job-id`, and a selected job outside
`--analysis --once` are rejected. Parser and actual supervisor regressions:
15 tests passed. A misspelled mode cannot silently start the default service.

Normal analysis cycles first prepare at most one accepted, confirmed original
source into a durable production job through the scoped ANALYZE identity.
Preparation reads registry/metadata references and invokes no provider. Unknown
quality, unpublished prompts and unavailable profiles remain deferred; a key
alone never grants admission. The source arrival clock/origin are preserved.
The first automatic snapshot and enqueue/outbox are atomic, with current worker,
source permission and prompt-use guards. Subsequent scans do not reprocess an
already planned source when a new prompt/profile is published.

Source scan cursors are progress hints kept in the local process, not authority.
They wrap after the last page, so unqualified early sources cannot starve later
ones; restart safely rescans durable accepted sources. Ordinary pulls filter
PRODUCTION before the candidate limit and the local worker checks this again.
They do not execute pending QUALITY_TEST experiments. A selected `--job-id`
cycle skips automatic planning and retains its explicitly bounded test scope.

Normal idle polling waits 30 seconds. Search that progressed waits 250 ms. Consecutive cycle failures wait 30, 60, then at most 120 seconds; a successful cycle resets this backoff. Authentication denial stops the process with a nonzero code and requires repair of the scoped credential. Logs contain only fixed cycle events and bounded RPC route/status metadata, never exception stacks, source content or credentials.

SIGINT/SIGTERM stop further pulls and immediately interrupt the idle/backoff timer. An in-flight cycle finishes its bounded protocol before shutdown; forcibly killing the process relies on durable lease expiry and fencing for recovery. This command does not install autostart or claim that a process is running merely because configuration exists.

To run all configured services that do not call AI providers, replace `run-local.ts` with `run-services.ts` in the command above. It starts transcript, source correction and search only when their scoped credentials are configured. All configurations are checked before any child starts. Each child receives its own worker credential and the operating-system environment needed by its runtime; OAuth, Cloudflare and Gemini secrets are excluded. Child output is suppressed and the supervisor emits fixed lifecycle events.

A crashed child restarts after 30/60/120 seconds, with one child per service. Continuous authentication denial exits with code 78 and stops that service; `--once` retains failure code 1. Other services continue independently. Supervisor shutdown requests termination and enforces a 30-second kill bound. On Windows, process termination can be immediate; durable leases and fencing recover interrupted work. The supervisor does not start Gemini modes or install a scheduled task.

After the search index reaches a fresh COMPLETE cut, each search step completes
at most one existing due PROJECT intent for an accepted source/result. It uses
the scoped PROJECT identity, lease and fencing token; the final atomic write
rechecks current content changes, source acceptance and worker revocation.
Completion does not create another analysis run or recursively enqueue PROJECT.
A concurrent content change leaves the attempt unaccepted; ordinary lease
expiry/recovery and a fresh index allow retry. No provider call is involved.

The search process publishes its local heartbeat at startup and at most once
per minute. Fast index steps do not publish a heartbeat on every request.
Authentication denial prevents subsequent work; a failed heartbeat is retried
on the next cycle. Cycle acceptance reflects an actual completed projection.
Heartbeat/supervisor regressions: 7 tests passed, including bounded frequency,
transport failure and authentication denial in actual child processes.

On Windows use `tools/executor/start-services.ps1` to start or reuse the existing
supervisor; `-Check` validates configuration and reports its presence. It checks
the recorded process identity before reusing a PID and receives no secret values
on the command line. `-Wait` keeps a scheduling wrapper attached to that process.

`tools/executor/install-startup.ps1` registers an owner-logon Windows task with
Limited privileges, IgnoreNew instances, hidden execution and no execution time
limit. `-Check` is read-only; `-Remove` removes only the matching startup task,
leaving running services and Core data intact. A conflicting named task is never
overwritten. OAuth/Gemini credentials are not stored in task arguments. This
starts only configured non-AI services and does not imply continuous availability
while the owner is logged out or the computer is off.

Actual installation verification on 2026-10-08: task Running, Limited,
IgnoreNew, execution time limit PT0S; one supervisor before and after an explicit
second start. Both PowerShell files parsed without errors. Initial automatic
approval review could not evaluate installation; that attempt did not execute.
After the owner's continuation, review and installation succeeded. This record
sets no execution-resume waiting period.

Projection regression verification: 14 tests passed across projection jobs,
search, core recovery and outbox. The first race harness incorrectly injected
revocation before leasing (observed PENDING instead of RUNNING); it was corrected
to inject immediately before the final commit. Both content-change and revoked
worker races now reject completion, and expiry/rebuild recovery is verified.

Use `tools/executor/start-services.ps1 -Restart` after a verified local executor
change. It validates the recorded supervisor and all direct children before
stopping any process, allows only the exact system console host and pinned Node
executor path, then replaces the supervisor and scoped children. PID reuse is
checked against creation time before stopping children. It starts no AI service.
Interrupted work retains durable D1 leases and origin; stale completion remains
fenced. `-Check -Restart` is rejected. Process command lines are never printed.

The caption subprocess uses asynchronous `execFile` so that network heartbeats
continue while Python runs. Existing timeout/output bounds and the environment
allowlist remain intact; child stderr and invalid output become fixed categories.
Checkpoint `126b15b`: 36 affected tests PASS, scoped lint/typecheck PASS and actual
Python invalid-input process check returned INVALID_LOCAL_INPUT before upstream
requests (zero). Initial restart failed closed before stopping anything because
Windows created a system conhost and used backslash separators. The corrected
launcher completed restart and check; read-only production heartbeats confirmed
all three non-AI services refreshed together after restart.
