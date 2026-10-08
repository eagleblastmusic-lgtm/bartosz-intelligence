# Model and prompt recovery

Gemini Free is the implemented profile. Runtime location remains a separate
choice. No recovery enables billing, another provider or heavy Edge captions.
An unavailable model leaves analysis deferred; source intake, existing accepted
knowledge and durable jobs remain available.

## Freeze the failing scope

Record the job/run IDs, immutable model/profile revision, prompt hash, schema,
mapper and fixed failure category. Preserve failed candidates and accepted
history. Check provider availability, current official quota, eligibility and
local executor state separately. A parser or transport failure does not prove a
model replacement is necessary.

## Prompt rollback

In Studio, select a previously published version of the same prompt family and
preview ROLLBACK with a reason. Inspect target hash, previous version and expected
generation, then confirm the existing preview. The implemented owner routes are
`/api/v1/prompts/publication/preview` and `/api/v1/prompts/publication/confirm`.
The Core publication boundary validates immutable versions and hash-bound
preview, owner scope, nonce and generation. A concurrent publication requires a
fresh preview; never bypass its conflict by editing SQL.

Rollback appends a pointer revision and audit record. It sends no model request,
creates no reprocessing job and changes no accepted selection. Already prepared
or running jobs keep their original snapshots. If pending work needs replacement,
use the existing explicit reprocess replacement preview and confirmation flow;
inspect its old-job fence and replacement snapshot before confirmation. Do not
silently rewrite the pending job or its arrival origin.

## Compatible model revision

Verify official model availability and capabilities, Free eligibility for the
owner's purpose/region and current quota. Publish a new immutable `gemini_free`
profile revision through the existing ModelRegistry boundary. Reusing a revision
with changed content fails IMMUTABLE_MODEL_CONFLICT. Publication alone supplies
no quality approval and does not authorize generation or production promotion.

Freeze comparable source runs, prompt, wire/canonical schemas, mapper, settings
and evaluation scope. Use existing QUALITY_TEST/Prompt Lab paths with explicit
material authorization and normal quota reservations. Preserve every provider
failure and compare actual output, source anchors, support, recall, hallucination
and usage under the required gate criteria. A local fixture, one successful
response or an AI review cannot replace required human evidence.

Only qualified scope may enter production. Revalidate affected source/quality,
capacity and CPU gates when the changed profile invalidates their assumptions.
Use an explicit compatible replacement snapshot rather than mutating accepted
results. Retain earlier model/prompt revisions for rollback. Canary or shadow
requests also require admission, authorization and measured quota; they never
automatically promote a model or consume a paid fallback.

## Current qualification

This procedure describes implemented boundaries, not an actual model promotion
receipt. Actual quality and remaining Gate R model/prompt recovery acceptance are
still unqualified. CP-3.13 remains AWAITING_HUMAN_REVIEW; its owner amendment does
not manufacture production quality approval. With no qualified replacement,
keep collection running and analysis visibly deferred.
