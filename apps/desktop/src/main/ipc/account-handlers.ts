/**
 * Account IPC Handlers
 *
 * Handles account-level IPC requests: account info, sign-out.
 * Device management (list/remove) uses existing SYNC_CHANNELS in sync-handlers.
 *
 * @module main/ipc/account-handlers
 */

import { ipcMain } from 'electron'
import { AccountChannels } from '@memry/contracts/ipc-channels'
import { asc } from 'drizzle-orm'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { createLogger } from '../lib/logger'
import { getDatabase, isDatabaseInitialized } from '../database/client'
import { store } from '../store'
import { teardownSession } from '../sync/session-teardown'
import {
  getBillingStatus,
  openBillingPortal,
  refreshBillingStatus,
  startBillingCheckout
} from '../billing/paddle-billing'

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

  ipcMain.handle(AccountChannels.invoke.START_CHECKOUT, async () => {
    log.info('account:startCheckout requested')
    return startBillingCheckout()
  })

  ipcMain.handle(AccountChannels.invoke.GET_BILLING_STATUS, async () => {
    log.info('account:getBillingStatus requested')
    return getBillingStatus()
  })

  ipcMain.handle(AccountChannels.invoke.REFRESH_BILLING_STATUS, async (_event, input) => {
    log.info('account:refreshBillingStatus requested')
    return refreshBillingStatus(input)
  })

  ipcMain.handle(AccountChannels.invoke.OPEN_BILLING_PORTAL, async () => {
    log.info('account:openBillingPortal requested')
    return openBillingPortal()
  })
}

export function unregisterAccountHandlers(): void {
  ipcMain.removeHandler(AccountChannels.invoke.GET_INFO)
  ipcMain.removeHandler(AccountChannels.invoke.SIGN_OUT)
  ipcMain.removeHandler(AccountChannels.invoke.START_CHECKOUT)
  ipcMain.removeHandler(AccountChannels.invoke.GET_BILLING_STATUS)
  ipcMain.removeHandler(AccountChannels.invoke.REFRESH_BILLING_STATUS)
  ipcMain.removeHandler(AccountChannels.invoke.OPEN_BILLING_PORTAL)
}
