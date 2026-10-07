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
