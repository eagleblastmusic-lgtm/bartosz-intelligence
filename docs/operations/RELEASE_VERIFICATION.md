# Release evidence evaluation

Run `pnpm release:verify --manifest <manifest.json> --output <new-report.json>`.
The command evaluates evidence only: it neither deploys nor activates providers.
Output uses exclusive creation and never overwrites an earlier report. Missing
input remains NOT_RUN. Current tracked candidate inputs must be clean; migration
files and ledger hashes are independently verified by the existing pin generator.

`ReleaseManifest/1.0` contains candidate/migration fingerprints, paid services
false and rows 1–20 from Stage 08's production checklist. Each row has a state
and hash-bound relative JSON evidence references. Missing rows remain NOT_RUN.
Only conditional Bridge/optional-component rows 14/15 can be DISABLED or
UNAVAILABLE. Required AI, Drive, recovery and backup rows cannot be disabled.
Only capacity row 18 can be OBSERVING or NOT_YET_MATURE under the owner execution
amendment; incomplete active-path acceptance still prevents implementation COMPLETE.

Each `ReleaseObservation/1.0` binds its row/state to the same candidate and
migration set, identifies an actual observation and references primary evidence
whose bytes are also verified. Unknown fields, simulation, future observations,
missing primary evidence, hash mismatch and incompatible pins are rejected.
Exact shapes are defined in `tools/release/evaluate.ts`. Observers must prepare
receipts from actual checks, never relabel synthetic unit fixtures as observations.
Hash verification proves evidence identity; reviewers must verify that its content
supports the row, scope and actual qualifying gate.

The result separates implementation completeness from long-run observation.
An otherwise complete implementation with immature capacity remains unqualified
for mature production release; Gate C is never converted to PASS. Required FAIL
has precedence. The command cannot create a global release approval by merely
being listed or run without actual receipts. No completed release is currently
claimed. Evaluator and related Gate R regressions: 23 tests passed; scoped lint
and tools typecheck passed.
