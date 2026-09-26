import type { ResolveVaultBindingResult, VaultBindingChoice } from '@memry/contracts/ipc-sync-ops'

import { getDatabase, isDatabaseInitialized } from '../database/client'
import { createLogger } from '../lib/logger'
import { findVault, getCurrentVaultPath, upsertVault } from '../store'
import { startSyncRuntime } from './runtime'
import { adoptVaultLocally } from './vault-adoption'
import { refreshVaultDirectory } from './vault-directory'
import {
  bindVaultForSync,
  getSignedInUserId,
  getVaultBindingState,
  isChoiceAllowed,
  setVaultBindingState,
  writeVaultAccountBinding
} from './vault-account-binding'

const log = createLogger('Sync:VaultBindingResolve')

/** Apply the user's answer to the open vault's binding prompt. */
export async function resolveOpenVaultBinding(
  choice: VaultBindingChoice
): Promise<ResolveVaultBindingResult> {
  const state = getVaultBindingState()
  if (!isDatabaseInitialized() || !isChoiceAllowed(state, choice)) {
    return { success: false, state, error: 'This vault cannot change how it syncs right now' }
  }
  const userId = await getSignedInUserId()
  if (!userId) return { success: false, state, error: 'Sign in to sync this vault' }

  const db = getDatabase()

  if (choice === 'local') {
    writeVaultAccountBinding(db, { userId, mode: 'local' })
    setVaultBindingState({ status: 'local-only' })
    log.info('Vault kept on this device')
    return { success: true, state: getVaultBindingState() }
  }

  if (choice === 'merge') {
    // isChoiceAllowed guarantees a target for 'merge'.
    const target = state.status === 'needs-decision' ? state.mergeTarget : null
    if (!target) return { success: false, state, error: 'No account vault to merge into' }
    adoptVaultLocally(db, target.vaultUuid)
    const vaultPath = getCurrentVaultPath()
    const stored = vaultPath ? findVault(vaultPath) : undefined
    if (stored) upsertVault({ ...stored, vaultUuid: target.vaultUuid })
  }

  bindVaultForSync(db, userId)
  setVaultBindingState({ status: 'bound' })
  log.info('Vault bound by user choice', { choice })
  void startSyncRuntime().catch((err) => log.warn('Sync start after binding failed', err))
  void refreshVaultDirectory({ force: true }).catch(() => {})
  return { success: true, state: getVaultBindingState() }
}
