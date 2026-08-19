import { eq, sql } from 'drizzle-orm'

import * as schema from '@memry/db-schema/data-schema'
import type { DataDb } from '../database/types'
import { VAULT_KEY_VERIFIER_SETTING } from '../crypto/vault-key-state'
import { resetVaultUuidCache } from '../agent/storage/vault-id'
import { createLogger } from '../lib/logger'
import { recordCrdtStoreRename } from '../store'

const logger = createLogger('Sync:VaultAdoption')

/**
 * The uuid currently in vault_metadata, or undefined when the vault has never
 * had one.
 *
 * Deliberately not `getOrCreateVaultUuid`: a vault provisioned for linking
 * (`createDormantVault`) adopts before anything has ever asked for its
 * identity, and minting one here just to overwrite it a line later would invent
 * a predecessor that no store was ever named after.
 */
function readVaultUuid(db: DataDb): string | undefined {
  return db
    .select()
    .from(schema.vaultMetadata)
    .where(eq(schema.vaultMetadata.id, 'singleton'))
    .get()?.vaultUuid
}

/**
 * Adopt a shared vault identity on the local (joiner) device before device
 * registration. Mirrors the proven test-hook sequence (test-hooks.ts:255-266):
 * clear the stale local vault-key verifier so the shared master key can rebind,
 * then upsert the adopted uuid into the vault_metadata singleton. After this,
 * getOrCreateVaultUuid() returns `vaultUuid`, so registration binds the device
 * to the initiator's vault and the first sync pulls that vault's items.
 */
export function adoptVaultLocally(db: DataDb, vaultUuid: string): void {
  // The vault's CRDT store is a directory named after this uuid, resolved once
  // when the provider opened it — which, on the joiner, is long before the user
  // scanned a QR code. So the rewrite below silently renames the vault out from
  // under its own history: nothing breaks in-session (the directory is already
  // open) and then the next open looks for a store that does not exist. Leave a
  // note for it, BEFORE the rewrite, so a crash in between costs an inert entry
  // rather than the history. See `settlePendingCrdtStoreRename`.
  const previousUuid = readVaultUuid(db)
  if (previousUuid !== undefined && previousUuid !== vaultUuid) {
    recordCrdtStoreRename(previousUuid, vaultUuid)
  }

  const now = Date.now()
  db.transaction((tx) => {
    tx.run(sql`DELETE FROM settings WHERE key = ${VAULT_KEY_VERIFIER_SETTING}`)
    tx.run(
      sql`INSERT INTO vault_metadata (id, vault_uuid, created_at, updated_at)
          VALUES ('singleton', ${vaultUuid}, ${now}, ${now})
          ON CONFLICT(id) DO UPDATE SET
            vault_uuid = excluded.vault_uuid,
            updated_at = excluded.updated_at`
    )
  })
  // The adopted uuid replaces the local one on the SAME database handle, so the
  // handle-keyed cache in getOrCreateVaultUuid would keep handing back the
  // pre-adoption identity to every call site — the request header, the device
  // registration that immediately follows, and the vault-key derivation.
  resetVaultUuidCache()
  logger.info('Adopted shared vault identity for linked device', { vaultUuid })
}
