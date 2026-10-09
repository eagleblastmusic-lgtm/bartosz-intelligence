# Private core backup and isolated restore

Sign in as the established owner and select **Pobierz prywatny backup**. The application freezes canonical mutations for at most two minutes, collects bounded chunks, verifies the manifest in the browser and downloads a private JSON file. Keep that file outside the database. A server VERIFIED record without a saved file is not an independent backup. If the export fails or the browser disconnects, the barrier expires automatically; retry with a new cut. Never publish the downloaded file or commit it to Git.

From the repository, with the pinned Node/tsx toolchain on PATH and the private `.env` containing the already verified `GOOGLE_OIDC_OWNER_SUBJECT`, verify the actual file and restore to an isolated local database:

```powershell
pnpm exec tsx --env-file=.env tools/db/restore-core.ts '<absolute path to downloaded private JSON>'
```

The command validates the migration ledger, owner binding, chunk hashes, counts and references before import. It refuses an existing target. The new database and private recovery locator are under ignored `.local/backups/<backup UUID>`. Its output contains only counts, result and the backup UUID. Integrity/FK checks must PASS. The locator records the actual file path/checksum, manifest checksum, restored database path and verification timestamp outside D1.

Restored worker credentials are revoked, sessions are absent, and interrupted jobs return to due retry with incremented fences. Re-establish credentials through the authorized provisioning workflow; do not reactivate historical credential hashes. Restore does not overwrite or switch production D1. A partial target is never activated; preserve it for diagnosis and use a fresh target after fixing the cause.

The current format v2 includes the canonical tables through the verified migration ledger. The original Stage 02 v1 pilot limits remain a historical scope, not the limits of current backups. Credentials and active sessions are excluded or revoked by restore. Schema additions must extend the exporter, validator and restore tests with their forward migrations.

The private Drive archive is configured in `config/drive-backup.json`. The owner selected canonical-json: verified secret-free JSON, without application encryption or a separate key. The existing hourly cadence reserves each immutable backup UUID/file ID before create and verifies download, SHA-256 and portable integrity. Destination content must remain private-owner-only. Large archive transfers have a bounded 120-second timeout; an ambiguous create is reconciled on the same reserved ID. Local backup remains usable when Drive is unavailable. Upload failure never enables a paid fallback or deletes a local copy.

The optional aes256gcm format remains available. Only that format requires its dedicated recovery key under `%LOCALAPPDATA%\Bartosz Intelligence\Recovery\canonical-backup-key-v1.json`, protected for the owner and SYSTEM. Keep an independent protected copy of that key outside Drive, D1 and the repository; losing the key makes the encrypted archives unrecoverable. The key is never embedded in an archive or receipt. Existing OAuth wrapping keys are not reused as canonical backup keys.

Explicit archive verification uses `tools/deployment/drive-backup.ts --backup '<private canonical JSON>'` with the pinned Node/tsx environment. The downloaded and decrypted canonical copy is saved to ignored, private `.local/drive-backups/<backup UUID>-downloaded.json`. Pass that copy to the existing `restore-core.ts` command with a new `--target-directory` under `.local`; an existing database is always refused. A PASS for archive transfer and empty restore alone does not establish full application RPO/RTO or restored service availability.
