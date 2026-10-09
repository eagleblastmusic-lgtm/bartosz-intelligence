# Reserved-create response-loss verification

Candidate `091b7a3` implements one bounded trial through the existing DriveClient
and Production OAuth renewal. Run the pinned Node/tsx CLI
`tools/deployment/drive-create-recovery-live.ts --live <connection_id> <root_id>`
with local credentials. The connection must be CONNECTED and its owner-approved
root VERIFIED. The adapter verifies private-folder permissions independently.
Paid policy must remain false. The short administrative session is revoked.

Before create, persist an immutable D1 intent with the reserved remote ID, trial,
scope and acceptance expectations. The atomic insert limits this probe to one
trial per connection/root, including concurrent invocations. A failed trial never
authorizes another reserved ID or create. Keep its original intent for readback
and explicit recovery. No existing Daily file or export state is changed.

The transport discards only a successful actual Google create response. This is
a controlled response-loss injection, not a naturally occurring network outage.
The real adapter must classify TRANSPORT; an independent client then reads the
same reserved ID, parent, private marker, MIME/trash/version and complete bytes.
Acceptance requires exactly one create and equal independently computed SHA-256.
Provider rejection, changed bytes or foreign metadata cannot be reported as
recovered. Probe files are retained privately as verification evidence.

Actual trial `8c5d75bd-0e30-4cc4-863a-2c00e19dd65d` PASS:
one create, correct durable reserved identity, independent 83-byte/hash readback,
and real token renewal. Primary receipt:
`8c5d75bd-0e30-4cc4-863a-2c00e19dd65d.json`.
Thirteen targeted adapter/guard/probe regressions, tools typecheck and scoped lint
passed. Fixture tests are separate from this actual provider observation.

This qualifies the reserved-create/client reconciliation mechanism in the stated
scope. It does not exercise full DailyExportExecutor recovery or a real outage,
prove human Compact quality, close all D-export cases or enable automatic export.
Full Gate D and global release remain unqualified; no AI request was performed.
