# Sync D1 schema

Memry sync is still pre-production. The paid-sync entitlement and vault-scope schema is
reset-only for remote environments: deploy it to an empty D1 database, or explicitly
drop/recreate the target D1 before deploying sync-server code that reads `sync_entitlements`,
`sync_vaults`, or `vault_id` columns.

Do not roll this schema over an existing pre-paid-sync D1 without a table rebuild migration.
The code expects vault-scoped unique keys for records, cursors, CRDT rows, upload sessions, and
blob chunks.
