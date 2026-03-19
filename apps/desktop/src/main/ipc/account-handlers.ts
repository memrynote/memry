/**
 * Account IPC Handlers
 *
 * Handles account-level IPC requests: account info, sign-out.
 * Device management (list/remove) uses existing SYNC_CHANNELS in sync-handlers.
 *
 * @module main/ipc/account-handlers
 */

import { ipcMain } from 'electron'
import sodium from 'libsodium-wrappers-sumo'
import { AccountChannels } from '@memry/contracts/ipc-channels'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { asc } from 'drizzle-orm'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { createLogger } from '../lib/logger'
import { getDatabase, isDatabaseInitialized } from '../database/client'
import { store } from '../store'
import { teardownSession } from '../sync/session-teardown'
import { retrieveKey } from '../crypto'
import { getValidAccessToken } from '../sync/token-manager'

const log = createLogger('IPC:Account')

export interface AccountInfo {
  email: string | null
  joinedAt: number | null
}

function getAccountInfo(): AccountInfo {
  const email = store.get('sync').email ?? null

  let joinedAt: number | null = null
  if (isDatabaseInitialized()) {
    const db = getDatabase()
    const earliest = db
      .select({ linkedAt: syncDevices.linkedAt })
      .from(syncDevices)
      .orderBy(asc(syncDevices.linkedAt))
      .limit(1)
      .get()
    if (earliest) {
      joinedAt = earliest.linkedAt.getTime()
    }
  }

  return { email, joinedAt }
}

export function registerAccountHandlers(): void {
  ipcMain.handle(AccountChannels.invoke.GET_INFO, () => {
    log.info('account:getInfo requested')
    return getAccountInfo()
  })

  ipcMain.handle(AccountChannels.invoke.SIGN_OUT, async () => {
    log.info('account:signOut requested')
    const result = await teardownSession('logout')
    return {
      success: true,
      ...(result.keychainFailures.length > 0 && {
        keychainWarning: `Failed to remove: ${result.keychainFailures.join(', ')}`
      })
    }
  })

  ipcMain.handle(AccountChannels.invoke.GET_RECOVERY_KEY, async () => {
    log.info('account:getRecoveryKey requested')
    const token = await getValidAccessToken()
    if (!token) {
      return { success: false, error: 'Not authenticated' }
    }
    try {
      const masterKey = await retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY)
      if (!masterKey) {
        return { success: false, error: 'Recovery key not available on this device' }
      }
      const encoded = sodium.to_base64(masterKey, sodium.base64_variants.URLSAFE_NO_PADDING)
      return { success: true, key: encoded }
    } catch (err) {
      log.error('Failed to retrieve recovery key', err)
      return { success: false, error: 'Failed to retrieve recovery key' }
    }
  })
}

export function unregisterAccountHandlers(): void {
  ipcMain.removeHandler(AccountChannels.invoke.GET_INFO)
  ipcMain.removeHandler(AccountChannels.invoke.SIGN_OUT)
  ipcMain.removeHandler(AccountChannels.invoke.GET_RECOVERY_KEY)
}
