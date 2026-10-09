# Gate D evidence protocol

The two scorecards are independent. They evaluate previously captured actual
observations; they do not execute Google requests, schedule a ChatGPT task,
start Voice, publish approval, or enable automatic export.

Commands accept an existing frozen input and a new output filename:

```text
pnpm gate:d-export --manifest <manifest.json> --output <new-report.json>
pnpm gate:d-bridge --receipts <receipts.json> --output <new-report.json>
```

Missing arguments/observations return NOT_RUN with exit code 2. Invalid,
modified, simulated or scope-mismatched evidence fails closed. Outputs use
exclusive creation; never overwrite a historical report. Successful evaluation
only applies to the exact configuration hash. Preserve original actual source
receipts beside observations for audit. Do not convert mock tests, model claims,
footer screenshots or a manually read chat into unattended-run observations.

## Freeze configuration before running cases

Store UTF-8 JSON `configuration.json` with exactly these fields:

- `version`: `drive-gate-config:1`.
- `gate`: `D_EXPORT` or `D_BRIDGE`.
- `owner_id`, `connection_id`, `root_id`: actual approved mapping identifiers.
- `renderer_version`, `report_schema`: `1.1`.
- `cut_seq`: actual nonnegative frozen publication cut.
- `scope_dates`: actual publication dates in `YYYY-MM-DD` form, maximum 32.
- `consumer`: null for export; for Bridge an object with the actual `plan`,
  `workspace`, `model`, `chat` identifiers.

The input has exactly `version=drive-gate-evidence:1`, `gate`,
`configuration_path=configuration.json`, `configuration_sha256` (SHA-256 of
the exact file bytes), and `rows`. Configuration and each evidence file are
bounded to 256 KiB. Relative JSON paths must remain inside the evidence directory,
including after resolving filesystem links. Secret files are never input.

Each row contains `id`, `result` (PASS/FAIL/NOT_RUN/UNAVAILABLE) and `evidence`.
Each reference contains `path` and `sha256`. NOT_RUN has no evidence. The full
required check lists and per-check facts are pinned in
`tools/gates/drive-evidence.ts`; unknown/duplicate checks are rejected. Missing
checks appear individually as NOT_RUN, never implied PASS.

## Actual observations

Each referenced JSON observation has exactly:
`version=drive-gate-observation:1`, `kind=ACTUAL`, `configuration_sha256`,
`check`, `observed_at`, `observer`, `result`, `method`, `facts`.
Use a stable observer identifier, an actual past timestamp and the same frozen
scope. Facts contain bounded metadata/measurements and check-specific assertions
supported by the retained primary receipts; never credentials or source text.
The evaluator validates hashes, configuration, method, time, and required facts.
It cannot establish an external event merely from an assertion: the observer
must inspect the primary receipts before creating an ACTUAL observation.

Export observations use PROVIDER_READBACK; human Compact quality uses
HUMAN_REVIEW. Full-content acceptance additionally requires equal exact
rendered/readback SHA-256 and actual positive bytes. A quota/storage failure
simulation is supplementary evidence, not an ACTUAL provider qualification.

Bridge checks 1–6 use UNATTENDED_SCHEDULED; checks 7–8 use HUMAN_REVIEW;
check 9 uses OWNER_VOICE. Check 1 requires at least two actual unattended runs,
including the late run. Checks 3–4 require all-block/chunk/cursor coverage,
middle/end controls, a real large connector read, stable revisions and rejection
of mixed reads. Use `verifyDailyRead` for independent full-byte/count/hash checks
when the observer has the complete chunk receipts. Human attribution and Voice
observations require actual people; neither AI nor this evaluator supplies them.

FAIL is retained even if other checks are unavailable. An actual unavailable
capability yields UNAVAILABLE, while unperformed checks stay NOT_RUN. Current
lack of a task/Voice tool does not prove the owner's ChatGPT plan is unavailable.
No actual complete Gate D acceptance is claimed by this protocol.

CLI input hardening rejects nonregular files and manifests larger than 256 KiB
before reading bytes; the post-read bound remains in force if a file grows after
the initial stat. Targeted input/Drive/release regressions: 24 tests PASS; tools
typecheck and scoped lint PASS. This is input-boundary verification, not actual
provider or consumer acceptance.
