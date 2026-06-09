import { getDatabase, initDatabase } from '../database/client'
import { runMigrations } from '../database/migrate'
import { getDataDbPath, initVault } from '../vault/init'
import { createVaultInfo } from '../vault'
import { upsertVault } from '../store'
import { createLogger } from '../lib/logger'

import { adoptVaultLocally } from './vault-adoption'

const logger = createLogger('Sync:VaultProvisioning')

export function dormantVaultFolderName(vaultUuid: string): string {
  return `memry-vault-${vaultUuid.slice(0, 8)}`
}

/**
 * Create a local vault at `folderPath`, adopt `serverVaultUuid` into its
 * vault_metadata, and register it in the store — WITHOUT opening it as the
 * current vault or starting its sync runtime. Used to provision the "dormant"
 * vaults a user chose to pull during multi-vault linking; they sync only once
 * the user switches to them (reusing the account master key + registered device).
 *
 * NOTE: this transiently points the shared data.db singleton at `folderPath`.
 * Callers MUST open the intended primary vault (via selectVault) afterward so
 * the singleton ends on the correct current vault.
 */
export function createDormantVault(folderPath: string, serverVaultUuid: string): void {
  initVault(folderPath)
  const dataDbPath = getDataDbPath(folderPath)
  runMigrations(dataDbPath)
  initDatabase(dataDbPath)
  adoptVaultLocally(getDatabase(), serverVaultUuid)
  upsertVault(createVaultInfo(folderPath))
  logger.info('Provisioned dormant vault', { folderPath, serverVaultUuid })
}
