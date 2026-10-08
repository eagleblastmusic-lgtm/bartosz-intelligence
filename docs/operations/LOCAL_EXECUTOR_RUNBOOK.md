# Local executor operations

Run from the repository root with the pinned runtime, local `.env` and the credential for the selected task. Do not copy credential values into commands or logs.

```powershell
$env:PATH="$PWD\.tools\node-v24.21.0-win-x64;$env:PATH"
& .\.tools\node-v24.21.0-win-x64\node.exe --import tsx --env-file=.env tools/executor/run-local.ts
```

The default mode runs the qualified local yt-dlp transcript path using `LOCAL_WORKER_CREDENTIAL`. One process performs one cycle at a time. Cloud intake remains available while this process is offline; durable jobs, retries and fenced leases stay in D1. Restarting the process resumes normal admission/pull rather than recreating source requests.

`--source-corrections`, `--search`, `--analysis`, `--translation` and `--history` are separate modes with their scoped credentials. Provider modes additionally require the current qualified profile and conservative quota admission. A configured key alone does not qualify a pipeline. Paid fallback remains disabled. Do not start background analysis as a substitute for an explicitly bounded quality test.

For one explicitly selected analysis test use `--analysis --once --job-id <job_id>`. Selection never grants permission to process another job. `--once` exits after one cycle and returns a nonzero code on failure.

Normal idle polling waits 30 seconds. Search that progressed waits 250 ms. Consecutive cycle failures wait 30, 60, then at most 120 seconds; a successful cycle resets this backoff. Authentication denial stops the process with a nonzero code and requires repair of the scoped credential. Logs contain only fixed cycle events and bounded RPC route/status metadata, never exception stacks, source content or credentials.

SIGINT/SIGTERM stop further pulls and immediately interrupt the idle/backoff timer. An in-flight cycle finishes its bounded protocol before shutdown; forcibly killing the process relies on durable lease expiry and fencing for recovery. This command does not install autostart or claim that a process is running merely because configuration exists.
