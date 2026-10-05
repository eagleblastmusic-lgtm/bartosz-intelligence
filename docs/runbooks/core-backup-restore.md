# Private core backup and isolated restore

Sign in as the established owner and select **Pobierz prywatny backup**. The application freezes canonical mutations for at most two minutes, collects bounded chunks, verifies the manifest in the browser and downloads a private JSON file. Keep that file outside the database. A server VERIFIED record without a saved file is not an independent backup. If the export fails or the browser disconnects, the barrier expires automatically; retry with a new cut. Never publish the downloaded file or commit it to Git.

From the repository, with the pinned Node/tsx toolchain on PATH and the private `.env` containing the already verified `GOOGLE_OIDC_OWNER_SUBJECT`, verify the actual file and restore to an isolated local database:

```powershell
pnpm exec tsx --env-file=.env tools/db/restore-core.ts '<absolute path to downloaded private JSON>'
```

The command validates the migration ledger, owner binding, chunk hashes, counts and references before import. It refuses an existing target. The new database and private recovery locator are under ignored `.local/backups/<backup UUID>`. Its output contains only counts, result and the backup UUID. Integrity/FK checks must PASS. The locator records the actual file path/checksum, manifest checksum, restored database path and verification timestamp outside D1.

Restored worker credentials are revoked, sessions are absent, and interrupted jobs return to due retry with incremented fences. Re-establish credentials through the authorized provisioning workflow; do not reactivate historical credential hashes. Restore does not overwrite or switch production D1. A partial target is never activated; preserve it for diagnosis and use a fresh target after fixing the cause.

This Stage 02 format covers 20 canonical control-plane tables. It excludes transient auth/telemetry and carries references to secrets, not their values. Limits are 25 rows / 64 KB per work unit, 200 chunks / 2 MiB of rows per pilot cut. Schema additions must extend the exporter, validator and restore tests with their forward migrations. Stage 07 will add the planned private Drive medium; the approved current medium is owner download. Large-corpus and backup scheduling qualification remain later acceptance work, not evidence supplied by this pilot.
