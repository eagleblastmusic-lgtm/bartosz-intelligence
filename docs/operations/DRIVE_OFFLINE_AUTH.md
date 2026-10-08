# Drive offline authorization and private credential recovery

The backend Drive flow is separate from owner login. It requests only `openid`
and `https://www.googleapis.com/auth/drive.file`, with offline access and explicit
consent. It does not accumulate broader previously granted scopes. A fresh signed
Google ID token must match the allowlisted owner's subject, client and nonce.
State, browser cookie, PKCE, configured redirect and wrapping key ID are bound to
a single ten-minute intent; a consumed code is never replayed automatically.

The callback contract is the configured APP_ORIGIN plus
`/api/v1/connections/drive/callback`. This is separate from the existing owner
login callback. Register the exact deployed callback before a live Drive grant.
No owner settings, OAuth client, external consent or live root probe are inferred
from local fixture tests. The owner must choose the root; connection creation
leaves it UNSELECTED, publishing state UNKNOWN. Reconnect retains the root ID but
requires another access probe. Publishing/lifecycle verification remains required.

Server refresh credentials use AES-256-GCM, a fresh 96-bit IV and 128-bit tag.
Authenticated context binds owner, connection, Google subject and OAuth client.
The wrapping key is a separate non-exportable imported key: 32 random bytes,
canonical base64url, with an explicit key ID. It is never derived from session
or OIDC credentials. Its private server secret and approved recovery copy must
exist outside D1 before live authorization; D1 alone cannot recover a lost key.
Do not commit, display, log or export key material or credential values.

`drive_credentials` contains only encrypted envelopes. Ordinary Core snapshots
exclude that table and OAuth intents, while retaining `drive_connections` metadata
and root mapping. After restore, auth is REAUTH_REQUIRED, a mapped root is
VERIFY_REQUIRED, and private credential recovery is explicit. Recover the matching
external wrapping key and approved encrypted credential copy privately, or obtain
a new owner grant. Never enable exports on the strength of restored metadata alone.
Rotation authenticates the old envelope and reseals it under a new external key;
commit/verify the new envelope before retiring the old recovery key.

Renewal sends the decrypted refresh token only to the fixed Google token endpoint
without redirects. Returned access tokens remain server-side and are not stored
in Core. Missing scope on renewal uses the previously verified granted scopes;
insufficient or widened scopes are denied. Credential rotation and connection
metadata use a revision guard and unique receipt in one D1 batch. A late renewal
cannot replace a newer connection's encrypted grant. `invalid_grant` pauses auth
for explicit reconnect; transient transport/5xx does not become permanent account
failure. Caller retry/recovery policy must remain bounded.

Google documents limited refresh-token lifetimes for External apps in Testing,
including the seven-day case. Confirm the actual publishing state and successful
renewal before production qualification; do not infer an expiry date from fixtures.
Official references: [web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
and [refresh-token lifecycle](https://developers.google.com/identity/protocols/oauth2#expiration).

Local tests cover authenticated encryption, owner/account/client swaps, tampering,
rotation, independent OIDC behavior, intent replay/expiry, minimal scopes, signed
owner validation, reconnect races, redirects/body bounds, renewal/revocation,
mutation barrier and secret-free backup/restore. Live Drive authorization, renewal,
Picker/root child create-read-update, remote update guards and Gate D-export remain
NOT_RUN until their actual adapters, configuration and owner access are verified.

The transport adapter uses fixed Google origins, denies redirects, bounds response
bytes, reserves generated IDs and uploads raw `text/markdown` using multipart
metadata/media. Callers must persist the reserved ID before create and reconcile
ambiguity by that ID; the adapter does not retry or select a filename match.
Provider failures expose only fixed categories and bounded Retry-After values.
Bearer credentials are held in JavaScript private fields and omitted even from
adapter serialization. Automatic update currently fails before transport with
UNQUALIFIED_UPDATE: no If-Match support or remote atomicity is inferred from API
version metadata. Live method qualification and durable export orchestration are
still required. Official contracts:
[generate IDs](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds),
[create](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create),
[get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get).

`previewDriveRoot` accepts an explicitly selected accessible folder ID and checks
owner connection revision before and after remote inspection. A folder must be
untrashed with known canAddChildren capability. Actual account storage is checked;
unknown/unlimited capacity is not converted to zero. A root change previews
existing mapping count and duplicate risk, preserves old file IDs and does not
write or qualify the new root. Metadata access PASS remains distinct from actual
child create/read/update NOT_RUN; the latter needs a durable probe and live proof.

`DriveExportIdentity` persists a destination keyed by owner/root/publication date
and Europe/Warsaw. COMPACT/FULL share this identity. Repeated initialization is
idempotent; a connection/root must already be VERIFIED to acquire a destination
or lease. A generated remote ID is durably reserved before create; retries reuse
it, including after a fifteen-minute lease expires. Each new lease increments its
fence. Stale reserve/release cannot affect the current worker. D1 guards prevent
replacement of reserved/file IDs or mutation of root/day mapping. Private
appProperties bind owner hash, publication day and stable export key, rather than
a filename lookup. Restore preserves both reserved/file IDs, clears leases and
increments fences; recovered auth/root must be requalified before execution.
`DailyExportArtifacts` stores derived report bytes in immutable 32 KiB chunks,
independently of transcript/Item artifacts. A revision cannot acquire different
bytes or mode. Interrupted staging resumes under a current lease; readers reject
unsealed, missing or corrupted chunks and verify the full SHA-256 before upload.
The current artifact pointer cannot move backwards or be attached by a stale
fence. Portable backup includes manifests, chunks and pointer; restore replays
chunks before sealing manifests and preserves byte identity. The explicit 8 MiB
storage admission ceiling rejects a larger report without truncation; this is
separate from the Bridge token estimate/OVERSIZE classification.

`DailyExportExecutor` persists a durable attempt before initial raw Markdown
create. An ambiguous create gets one bounded GET of the reserved ID; a later
attempt reuses that ID and the sealed bytes. Metadata/appProperties and a stable
version across exact content readback are required before a fenced receipt can
advance exported_seq. A newer dirty_seq remains pending. Unrelated files,
missing committed files and changed remote bytes are preserved as conflicts.
Existing different bytes never receive an automatic update while the selected
remote conditional method is unqualified. Controlled local transport tests
cover accepted/unaccepted timeouts and an old executor finishing after lease
recovery; they do not qualify real Drive concurrency or production export.

The exact v2 media PUT conditional method passed actual trial
`d99d0b0d-4708-4586-9872-3923c55e96eb`: one of two concurrent writers succeeded,
the other returned 412, and a current-guard write had stable exact readback.
The immutable receipt qualifies this method for that connection/root. Full
D-export acceptance and the Testing authorization lifecycle remain open.

On Windows, `tools/deployment/drive-recovery.ts <absolute-private-directory>
<TESTING|PRODUCTION|INTERNAL>` prepares the owner-selected directory outside the
repository, grants DACL access only to the current owner and SYSTEM, rejects
unexpected existing access/reparse points, and writes the recovery copy before
local runtime configuration. Rerunning checks the same key and performs a
synthetic AES-GCM recovery roundtrip; it never rotates the active key implicitly.
Values are never printed. PowerShell 7/icacls changes access rules without
requesting Windows audit privileges. Real refresh-token recovery is a separate
live check after authorization. The owner's declared consent status is saved
with the connection; TESTING is never silently promoted to production.

The owner can explicitly create a named private root candidate through
`/connections/drive/root/create`. Its generated folder ID is persisted before
the remote create. A timeout reconciles that ID, and another request with the
same connection/name reuses it. Missing previously confirmed folders are not
silently recreated. Permissions must expose exactly one active user owner;
shared/public/domain access is rejected. The GUI shows the candidate and fills
its ID for inspection. Creation does not mark the connection root VERIFIED or
enable exports; actual child/update qualification remains required.

Root confirmation uses an immutable owner-scoped preview valid for ten minutes.
The server refreshes OAuth, rechecks private permissions/storage and the exact
successful guard receipt, and adopts the root with revision CAS. Changing a root
with existing mappings requires explicit mapping review; old IDs are preserved.
The durable change cursor resets to replay historical publication dates into
the selected root. Confirmation alone does not enable the scheduler.

## Unattended export runtime

Actual owner root confirmation and single-day production export have been
verified. Receipts `docs/verification/drive/7dad1744-116e-4284-900f-eee2a87a1e79.json`
and `docs/verification/drive/c6a9e094-ef59-411c-ade4-a219d686af2c.json` record
offline token renewal, the same persisted Daily file identity and independent
content hash readback. The second execution returned NO_MATERIAL_CHANGE.
These are actual application data, without generated AI results or synthetic
source changes. They do not qualify the entire D-export gate, human compact
quality, unattended scheduling or production OAuth publishing lifecycle.

Actual COMPACT → FULL → COMPACT verification also passed on the same file:
`docs/verification/drive/0b502df2-7a86-4149-80c8-24eee2c091b1.json` (revision 3)
and `docs/verification/drive/ea9032ff-5592-4af4-b797-f8a978fd5cd4.json`
(revision 4). Both executions renewed offline access and independently matched
the remote content hash. The final mode is COMPACT. Targeted export runtime,
executor and scope tests passed (14), as did identity and manual-conflict tests
(10); tools typecheck and scoped lint passed. No live manual user file was
edited to manufacture conflict evidence.

For a bounded administrative verification, run the pinned Node with
`--env-file=.env --import=tsx tools/deployment/drive-export-live.ts --live
<connection_id> <owner-approved-root_id> <publication_date>`.
The runner uses the existing repositories and export fences, revokes its
temporary owner session and releases the lease. It writes only redacted
metadata receipts; it never enables the scheduler. A failed execution retains
the reserved file identity and existing recovery state. Re-run only for a
specific acceptance case or regression.
An explicit trailing `--mode FULL` or `--mode COMPACT` applies the existing
owner settings CAS before rendering; the omitted option retains the desired
mode. This option supports the required real same-file mode roundtrip.

The owner can choose Disconnect Drive and confirm explicitly. Revision CAS
removes the local encrypted offline credential, consumes pending OAuth intents
and invalidates export leases. Core data, Drive files and root/file mappings
are preserved. This local disconnect does not revoke the Google account grant;
the owner can separately remove that grant in Google account settings.
Reconnection must restore authorization and verify the retained root again.

Migration 034 adds durable retry count, next retry time, pause and failure code.
`prepare.mjs export-worker` registers only `DRIVE_EXPORT`, persists its private
credential before the hash, and refuses implicit rotation/recovery mismatches.
It does not start export. Prepare deployment secrets again after registration.
`DRIVE_EXPORT_ENABLED` defaults to disabled; activate only for the actual
qualified release scope after root selection and D-export verification.

Each existing five-minute scheduled tick independently replays at most 100
change events and attempts one fair due day. It uses the scoped worker identity,
not an owner browser session. Only accepted verified canonical artifacts are
read; no AI is invoked. A prepared sealed revision is reused after restart or
ambiguous HTTP, retaining its exact bytes. Late dirty changes remain queued.
Credential revocation and elapsed lease are checked before remote writes and
acceptance. A lost create/update response reconciles the persisted file ID.

Transient failures back off from five minutes to six hours, respect bounded
Retry-After (maximum one day), and pause after eight failed attempts. Conflicts,
denied access, invalid metadata and missing committed files pause immediately.
The owner sees the reason/count/next retry and can explicitly retry a recoverable
pause using expected settings revision. This never resolves or clears a manual
edit conflict; conflict resolution requires its separate reviewed workflow.
Core intake and job scheduling run independently of export failure.

## Manual conflict preservation

The owner can inspect a conflicted day and explicitly choose KEEP_MANUAL.
The preview reads the exact persisted file, private root and application identity,
checks stable metadata around a bounded raw read, and stores only hash/version/
size/mapping metadata in immutable config (never manual file text).
It expires after ten minutes. Confirmation refreshes OAuth and repeats the
read; a changed hash/version, mapping, settings or fence rejects the decision.
Confirmation CAS sets OWNER_PRESERVED_MANUAL, invalidates active leases and
leaves the remote file and accepted Core knowledge untouched. It does not
claim the manual bytes as an application export. Future changes for that day
remain paused and cannot be cleared by ordinary retry or a mode change.
The GUI links to the actual file for owner inspection and explains this effect.
This implements preservation; replacing a manual version requires a separate
reviewed action and is not silently performed by the exporter.
