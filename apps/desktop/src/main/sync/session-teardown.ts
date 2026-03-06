import { deleteKey } from '../crypto'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { syncHistory } from '@memry/db-schema/schema/sync-history'
import { eq } from 'drizzle-orm'
import { stopSyncRuntime } from './runtime'
import { resetTokenManagerState } from './token-manager'
import { getValidAccessToken } from './token-manager'
import { clearPendingSession, clearPendingLinkCompletion } from './linking-service'
import { getCrdtProvider, resetCrdtProvider } from './crdt-provider'
import { clearInMemoryAuthState } from '../ipc/sync-handlers'
import { getDatabase, isDatabaseInitialized } from '../database/client'
import { store } from '../store'
import { createLogger } from '../lib/logger'

const log = createLogger('SessionTeardown')

export type TeardownReason = 'logout' | 'integrity' | 'shutdown'

export interface TeardownResult {
  success: boolean
  keychainFailures: string[]
}

let teardownInProgress: Promise<TeardownResult> | null = null

export async function teardownSession(reason: TeardownReason): Promise<TeardownResult> {
  if (teardownInProgress) {
    log.info('Teardown already in progress, awaiting existing')
    return teardownInProgress
  }

  teardownInProgress = performTeardown(reason)
  try {
    return await teardownInProgress
  } finally {
    teardownInProgress = null
  }
}

async function performTeardown(reason: TeardownReason): Promise<TeardownResult> {
  log.info('Session teardown started', { reason })
  const keychainFailures: string[] = []

  const skipSync = reason === 'logout' || reason === 'integrity'
  await stopSyncRuntime({ skipFinalSync: skipSync })
  resetTokenManagerState()

  if (reason === 'logout') {
    await revokeServerSession()
  }

  clearInMemoryAuthState()
  clearPendingSession()
  clearPendingLinkCompletion()

  const keychainEntries = [
    KEYCHAIN_ENTRIES.ACCESS_TOKEN,
    KEYCHAIN_ENTRIES.REFRESH_TOKEN,
    KEYCHAIN_ENTRIES.SETUP_TOKEN,
    KEYCHAIN_ENTRIES.MASTER_KEY,
    KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY
  ]
  const results = await Promise.allSettled(keychainEntries.map((entry) => deleteKey(entry)))
  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      const account = keychainEntries[i].account
      log.error(`Failed to delete keychain entry: ${account}`, result.reason)
      keychainFailures.push(account)
    }
  }

  if (isDatabaseInitialized()) {
    const db = getDatabase()
    if (reason === 'integrity') {
      db.delete(syncDevices).where(eq(syncDevices.isCurrentDevice, true)).run()
    } else {
      db.transaction((tx) => {
        tx.delete(syncQueue).run()
        tx.delete(syncDevices).run()
        tx.delete(syncState).run()
        tx.delete(syncHistory).run()
      })
    }
  }

  store.set('sync', {})

  if (reason === 'logout') {
    try {
      await getCrdtProvider().wipeStorage()
    } catch (err) {
      log.warn('CRDT storage wipe failed', err)
    }
    resetCrdtProvider()
  }

  log.info('Session teardown complete', { reason, keychainFailures: keychainFailures.length })
  return { success: true, keychainFailures }
}

async function revokeServerSession(): Promise<void> {
  try {
    const token = await getValidAccessToken()
    if (!token) return

    const { postToServer } = await import('./http-client')
    await postToServer('/auth/logout', {}, token)
    log.info('Server session revoked')
  } catch (err) {
    log.warn('Server-side token revocation failed (best-effort)', err)
  }
}
