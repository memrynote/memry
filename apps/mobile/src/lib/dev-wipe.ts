import { createLogger } from './logger'
import { clearVaultKey, clearDeviceSigningKeypair, clearDeviceId } from './secure-store'
import { clearSession, clearCurrentVaultId, loadCurrentVaultId } from '../sync/auth-client'
import { closeVaultDb, vaultsRootDir } from '../db'

const log = createLogger('DevWipe')

/**
 * Dev-only clean-slate wipe (drill tooling, not a user feature).
 *
 * The iOS keychain survives app deletion and reinstall, so a fresh install
 * alone never returns to the sign-in screen — the entry gate finds the old
 * session + vault key in secure-store and jumps straight into the vault, and
 * `Documents/vaults` survives install-over-install too. This clears every
 * secure-store entry we write (data-model §2) plus the vaults directory so the
 * next cold start is a true first launch.
 *
 * The caller must kill + relaunch afterwards: in-process engine/doc state is
 * NOT reset here, and a live sync pass could recreate files after the delete.
 */
export async function wipeDeviceState(): Promise<void> {
  const root = vaultsRootDir()
  const vaultIds = new Set<string>()
  if (root.exists) {
    for (const entry of root.list()) vaultIds.add(entry.name)
  }
  const current = await loadCurrentVaultId()
  if (current) vaultIds.add(current)
  // Registration stores the account-scoped signing keypair under this id.
  vaultIds.add('account')

  for (const vaultId of vaultIds) {
    await closeVaultDb(vaultId)
    await clearVaultKey(vaultId)
    await clearDeviceSigningKeypair(vaultId)
  }
  await clearSession()
  await clearCurrentVaultId()
  await clearDeviceId()
  if (root.exists) root.delete()
  log.info('Device state wiped', { vaults: vaultIds.size })
}
