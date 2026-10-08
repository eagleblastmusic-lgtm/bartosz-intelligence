# Drive guard qualification protocol

Second method preregistration, 2026-10-08: after the v3 response lacked an ETag, explicitly select `V2_MEDIA_PUT_IF_MATCH` as the last CLI argument. The [official v2 File resource](https://developers.google.com/workspace/drive/api/reference/rest/v2/files) exposes JSON `etag`; [v2 files.update](https://developers.google.com/workspace/drive/api/reference/rest/v2/files/update) supports media PUT with drive.file scope. Use that exact JSON ETag with If-Match on v2 media PUT. Validate private properties, parent, MIME and trash state in the same v2 metadata response. All existing acceptance checks and the shared maximum of three persisted trials per connection/root remain unchanged. No automatic fallback occurs inside a trial; no production update activation follows merely from transport tests.

This protocol is preparation, not a live PASS. Automatic updates remain disabled.

Run `tools/deployment/drive-guard-probe.ts --live <connection_id> <root_id>` with the pinned Node/tsx runtime and local `.env` only after the owner has granted Drive access and created an application root candidate. The command requires a CONNECTED connection, an app-created CREATED root and the existing recovery-ready wrapping key. It creates a short administrative session and revokes it on exit.

Before creating a canary, reserve its Drive ID and persist an immutable intent in D1. Allow at most three trials per connection/root; each invocation performs one trial. A used canary is retained as evidence and never reset, overwritten for a rerun or deleted. No Daily data enters this probe.

The exact candidate method is [Drive v3 files.update media PATCH](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update), with `If-Match` using a strong metadata ETag. The documentation confirms the endpoint, not the conditional concurrency behavior; that behavior requires live qualification.

Acceptance requires:

- A private root, correct reserved file ID, parent and immutable probe marker.
- Two concurrent synthetic writes using the same strong ETag: exactly one succeeds and the other returns HTTP 412.
- Stable metadata/content readback matching the successful writer and a changed ETag.
- A subsequent write using the current ETag succeeds, changes the ETag and has stable exact content readback.

Missing or weak ETags, ambiguous transport, ignored guards, changed canary contents and foreign files fail closed. There is no retry or alternate method in the trial. Numeric HTTP status and fixed failure categories are recorded; credentials, tokens and provider response bodies are excluded. The immutable result and Git-safe receipt distinguish actual live results from unit transport fixtures. A PASS does not itself enable the production update adapter or close the complete Drive export gate.
