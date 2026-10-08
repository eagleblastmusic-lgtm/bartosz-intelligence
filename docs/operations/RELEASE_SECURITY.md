# Release security checks

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
