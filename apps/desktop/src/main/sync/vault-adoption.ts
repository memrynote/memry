import { sql } from 'drizzle-orm'

import type { DataDb } from '../database/types'
import { VAULT_KEY_VERIFIER_SETTING } from '../crypto/vault-key-state'
import { resetVaultUuidCache } from '../agent/storage/vault-id'
import { createLogger } from '../lib/logger'

const logger = createLogger('Sync:VaultAdoption')

/**
 * Adopt a shared vault identity on the local (joiner) device before device
 * registration. Mirrors the proven test-hook sequence (test-hooks.ts:255-266):
 * clear the stale local vault-key verifier so the shared master key can rebind,
 * then upsert the adopted uuid into the vault_metadata singleton. After this,
 * getOrCreateVaultUuid() returns `vaultUuid`, so registration binds the device
 * to the initiator's vault and the first sync pulls that vault's items.
 */
export function adoptVaultLocally(db: DataDb, vaultUuid: string): void {
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
