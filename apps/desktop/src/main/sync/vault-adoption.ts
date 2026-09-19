import { eq, sql } from 'drizzle-orm'

import * as schema from '@memry/db-schema/data-schema'
import type { DataDb } from '../database/types'
import { VAULT_KEY_VERIFIER_SETTING } from '../crypto/vault-key-state'
import { resetVaultUuidCache } from '../agent/storage/vault-id'
import { createLogger } from '../lib/logger'
import { recordCrdtStoreRename } from '../store'
import { getFromServer } from './http-client'

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

/**
 * Make a just-registered device sync the account's vault instead of minting a
 * second one.
 *
 * QR linking adopts the initiator's vault uuid (`finalizeLinking`). Signing in
 * with an OTP + recovery phrase adopted nothing, so whatever folder happened to
 * be open kept its freshly minted local uuid and every push asked for another
 * vault slot: on Plus (`max_vaults = 1`) that is `SYNC_VAULT_LIMIT_EXCEEDED`
 * forever while the account's real vault keeps syncing from the first machine
 * (#2226). A slot must be spent on purpose — creating a vault from the
 * switcher — never as a side effect of signing in.
 *
 * Returns the uuid this device should sync under: the adopted one, or the local
 * one when there is nothing to adopt (new account, or the open vault is already
 * the account's). Never throws — a vault list that cannot be fetched leaves the
 * pre-existing behaviour rather than failing the sign-in.
 *
 * ponytail: on a multi-vault account this binds to the most populated vault
 * instead of asking. The other vaults stay reachable from the switcher
 * ("In your account") and Settings → Vault says which vault is open, so the
 * upgrade path is the same picker QR linking uses (`finalizeVaultChoice`) if
 * the guess turns out to be wrong often enough to matter.
 */
export async function adoptAccountVaultIfAbsent(
  db: DataDb,
  localVaultUuid: string,
  accessToken: string
): Promise<string> {
  let vaults: Array<{ vaultUuid: string; itemCount?: number }>
  try {
    ;({ vaults } = await getFromServer<{
      vaults: Array<{ vaultUuid: string; itemCount?: number }>
    }>('/sync/vaults', accessToken))
  } catch (err) {
    logger.warn('Could not enumerate account vaults after registration', err)
    return localVaultUuid
  }

  if (vaults.length === 0) return localVaultUuid
  if (vaults.some((vault) => vault.vaultUuid === localVaultUuid)) return localVaultUuid

  // The server already orders by item count, but the choice is load-bearing
  // enough not to depend on that.
  const target = [...vaults].sort((a, b) => (b.itemCount ?? 0) - (a.itemCount ?? 0))[0]
  adoptVaultLocally(db, target.vaultUuid)
  logger.info('Adopted account vault instead of registering a new one', {
    localVaultUuid,
    adopted: target.vaultUuid,
    accountVaultCount: vaults.length
  })
  return target.vaultUuid
}
