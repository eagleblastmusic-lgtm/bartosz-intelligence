# Gate E — FAIL / CP-1.4 BLOCKED

Resumed 2026-10-04. Initial Git check clean, ignored .env, OAuth authenticated and
selected account matches CLI identity. Google project and API credentials present;
Cloudflare API token intentionally empty. Secret values neither displayed nor
stored. Owner confirms private professional/business work, sole owner, Poland/EEA,
no public distribution. Prior missing-login/credential blockers are resolved.

## Actual evidence

- account-readonly.json: OAuth-authorized Workers settings, D1, Queues and scripts
  lists HTTP 200; subscriptions HTTP 403. One YouTube videos.list HTTP 200, one item.
  No generation or mutation; existing resources only read.
- dashboard-observations.json: contemporaneous redacted authenticated UI notes.
  Workers Free Current plan; 0/100,000 requests today, 10 ms CPU limit. Workers
  reports no billable usage October 1–November 1. Not global zero billing proof
  for unrelated existing resources.
- Google project billing disabled; AI Studio Free tier. YouTube actual quota
  10,000 queries/day, usage 1; separate search quota 100/day, usage 0.
- Gemini `gemini-3.8-flash` actual allowance in Rate Limit UI: 5 RPM/250K input
  TPM/20 RPD; observed peak 0/20 over 28 days. UI may lag 15 minutes. Reset is
  midnight America/Los_Angeles. Project billing disabled and Free tier observed.
- Current account-preflight.json and timestamped historical preflight preserve
  prerequisite changes. The account command reports FAIL on the current required
  probe; exit 2 denotes failed gate evaluation.

## Remaining active-path blocker

[Gemini terms](https://ai.google.dev/gemini-api/terms), effective March 23, 2026,
allow developer professional/business purpose; this requirement is now satisfied.
They restrict API Clients made available to EEA/CH/UK users to Paid Services.
They specify no sole-owner exception. The EEA data-processing provision does not
itself establish eligibility; a Free tier UI is not proof of permitted use.

The owner explicitly approved professional_single_owner classification after
these observations. This resolves the use-classification blocker for this project;
no individual confirmation from Google or legal opinion is claimed. Terms do not
describe developer=single user explicitly. Reverify on Terms, eligibility, billing,
project or audience change. Decision: owner-use-decision.json.

The canonical candidate `gemini-3.8-flash` was confirmed by project `models.list`
(HTTP 200; `generateContent` listed), then received exactly one bounded probe.
`generateContent` returned HTTP 200; the harness failed to parse/validate the
structured response. The run did not preserve response diagnostics or token
usage. Thus the probe is FAIL, not model unavailability. No retry/fallback was sent.
Evidence: `gemini-probe.json` and its settled reservation. The production route
remains disabled until structured capability is verified. An earlier invalid
probe and its reservation are in `legacy-invalid-probes/`; both are explicitly
invalidated and excluded from Gate E evidence because the implementation used a
model inconsistent with Master Architecture.

D1 actual per-DB/account capacity and usage, Queues usage/reset and Assets limits
and minimal real service probes remain incomplete. API discovery is not runtime
qualification. Drive is inactive/UNAVAILABLE pending storage/API/Pickers proof,
without configuring export or OAuth.

## Harness and controls

account-readonly.mjs captures OAuth in memory and emits selected response summaries.
metadata-admission.ts admits exact GET discovery endpoints on the selected account
plus one bounded YouTube lookup. Paid/unknown policy, other accounts, generation,
arbitrary domains and redirects fail closed before transport. This metadata scope
never grants production provider admission. Recorded live reads predate this added
boundary; the exact calls match its allowlist. Negative tests verify the boundary
without replaying reads. Historical evidence retains its original observations.

CP-1.1–CP-1.3 proofs remain valid. One bounded canonical Gemini request produced
HTTP 200 but failed response validation; no R2, paid fallback, trial baseline, proxy,
Workers AI, Deno, archive or managed STT route activated. No external resource
changed. CP-1.5–CP-1.8 and Stage 02 NOT_STARTED; Gate 0, CPU and 0B NOT_RUN.

## Resume

Resume exactly CP-1.4 with owner classification retained. Resolve actual model
generation availability against a fresh account capability/allowance snapshot;
preserve the failed case and use an explicit new bounded reservation if another
approved Free model is qualified. Do not replay this failed probe automatically.
Complete D1/Queues/Assets budgets and bounded probes. PASS must precede CP-1.5.
No architecture change established; do not edit Plan or enable paid fallback.
