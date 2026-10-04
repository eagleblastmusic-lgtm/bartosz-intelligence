# CP-1.4 resumed verification

2026-10-04. Scope: account discovery and refreshed blocked handoff only.

- Initial Git checkpoint clean; .env ignored; credentials presence only.
- Official Wrangler whoami JSON: exit 0, selected account matched in memory.
- Live read evidence: account-readonly.json (six bounded GETs, no generation).
- Authenticated UI evidence: dashboard-observations.json (no mutations).
- pnpm run gate:e --mode account: INCONCLUSIVE, underlying exit 2;
  OAuth selected account observed, exact-use eligibility blocker retained.
- Vitest unit: 3 files / 40 tests PASS, including nine new metadata boundary cases.
- tsc -p tsconfig.tools.json: PASS.
- eslint tools/gates tests/unit/metadata-admission.spec.ts: PASS.
- node --check tools/gates/account-readonly.mjs: PASS.
- Changed-file format, diff integrity and secret-value check: PASS before commit.

No replay of CP-1.1–CP-1.3; source/runtime/config inputs unchanged.
Previous 4 contract + 6 workerd + 1 Chromium proofs remain relevant.
Gate 0, CPU, 0B: NOT_RUN. Gate E: INCONCLUSIVE. Stage 01: BLOCKED.
DoD review is a failed completion assessment, not CP-1.8 or final clean-suite PASS.
Previous checkpoint reference: stage-01-cp-1.4-account-evidence.

## Canonical model correction

The prior gate attempt selected a noncanonical model. It is archived under
`legacy-invalid-probes/` as an invalid request and reservation; its HTTP 404 is
excluded from model availability conclusions. Only those two explicit legacy
JSON records retain that model identifier.

The owner selected `professional_single_owner`; caveats and change triggers are
recorded in `owner-use-decision.json`. Gemini Rate Limit UI for project
`bartosz-intelligence` showed Gemini 3.8 Flash 5 RPM / 250K input TPM / 20 RPD,
0 peak requests over 28 days. `models.list` then returned HTTP 200 and advertised
`generateContent` for the canonical candidate. Exactly one generation request
was submitted (max 64 output tokens, no tools/grounding, no retry). It returned
HTTP 200, but the harness did not establish valid structured output or preserve
response diagnostics/usage. This is a Gate E probe FAIL, not model unavailability.
No second generation was sent. Final checkpoint tag `stage-01-cp-1.4-gemini-3.8-probe`.
`production_enabled=false`,
`billing_route=disabled`.
Gate E account preflight is now FAIL; Gate 0, CPU and 0B remain NOT_RUN.
