# Release security checks

The public GitHub workflow uses Node24.21.0/pnpm12.9.1, pinned Actions commits,
`contents: read` and checkout `persist-credentials: false`. It runs local
build/tests including isolated D1 and browser fixtures, without production
secrets, deployment, remote SQL, Drive or Gemini. Its build scanner receives
only a clearly synthetic canary. A passing CI canary does not mean actual
production secret values were available to the public runner.

The 2026-10-11 consolidated audit separately checked actual local configured
secret variants in public build assets (4 files/413922 bytes/0 findings), plus
all reachable Git blobs, commit messages and tags at code e54a7be
(254 commits/2504 blobs/54225767 bytes/0 findings/0 private paths).
Patterns include configured credentials/owner subject and common Google,
GitHub, access-token/private-key/AWS formats. Matches are never printed.
This does not prove absence of arbitrary unknown credentials or every class
of private data. Check publication deltas before push, and inspect report/log
content rather than relying on a green scan alone. Keep `.env`, `.dev.vars`,
`.local`, `.tools`, full private `Plan/` and browser artifacts ignored.
The public Prompt Pack fixture is only the exact, hash-pinned schema/prompt
section already used by the application; its contract runs on clean clones.

If exposure is discovered, stop publishing affected material, preserve the
sanitized evidence, identify impacted credentials and arrange rotation.
Deleting a file only from HEAD does not remove it from public Git history.
History rewriting, tag changes and visibility changes require the relevant
owner decision; this audit found no exposure requiring those actions.
[Actual CI/audit evidence](../verification/release/CI_RADIO_P0_AUDIT_2026-10-11.md).

Run `pnpm release:secrets` from the repository root with the pinned runtime and
local `.env`. This reads the public web build and compares it with configured
secret values in memory, including literal, URL-encoded, JSON-escaped and base64
forms. Output contains only file paths, counts, byte totals and fixed categories;
no matching value, substring or secret hash is recorded. Missing secret input or
public build fails closed. Scan size, depth and file counts are bounded;
symlinks are rejected. This check does not print or copy `.env`.

On 2026-10-08 the actual existing public build passed: 4 files, 409413 bytes,
no findings. The affected verification passed 14 tests across secret canaries,
actual child-process isolation, auth API and runtime redirect rejection.
Typecheck and scoped lint passed. Repeat the scan after rebuilding public assets
or changing injected build configuration; this receipt is scoped to that build.

This scanner checks accidental exposure of configured values. It does not prove
that arbitrary unknown credentials are absent, replace owner/CSRF/task-scope
checks, or qualify provider no-tools/security gates. Current deployment and the
public bundle must be bound to the final release manifest before release claims.

Source response hardening found a concrete allocation gap: RSS and YouTube JSON
checked size only after `response.text()` had consumed the entire body. Both now
use a byte-bounded streaming reader (RSS 64000 bytes; YouTube 512000 bytes),
cancel oversized streams, preserve multibyte UTF-8 across chunks and reject invalid
UTF-8. YouTube classifies size/encoding violations as PARSER and body transport
failure as TRANSIENT, without recording provider diagnostics. The fixed endpoint
and no-redirect policy remain unchanged. This change performs no live source
request or Stage 01 requalification.

The affected source/recovery/runtime verification passed 14 tests, including
oversized chunked bodies without Content-Length, declared oversize, invalid UTF-8,
stream failure, RSS DTD/depth rejection and existing redirect protection.

The first Workers typecheck found its TextDecoder options require explicit
ignoreBOM. This compatibility failure was corrected with ignoreBOM=false;
the streaming byte bounds and strict UTF-8 behavior are unchanged.

The owner OIDC exchange had the same post-allocation size-check gap: token,
error and signing-key bodies were fully read before checking their length.
All three now use the shared streaming reader with a 32768-byte ceiling and
strict UTF-8. Oversized responses are cancelled before parsing or subsequent
requests; diagnostics retain only existing fixed categories, without provider
body text. Targeted workerd regression covers all three paths. The affected
OIDC/signature/reader/auth API suite passed 26 tests; scoped lint and API/Workers
typechecks passed. No new live Google consent was required or performed.
