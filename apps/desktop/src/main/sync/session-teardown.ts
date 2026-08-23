import { deleteKey } from '../crypto'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { syncHistory } from '@memry/db-schema/schema/sync-history'
import { eq } from 'drizzle-orm'
import { stopSyncRuntime } from './runtime'
import { markSyncIneligible } from '@memry/sync-client/sync-eligibility'
import { resetTokenManagerState } from './token-manager'
import { getValidAccessToken } from './token-manager'
import { clearPendingSession, clearPendingLinkCompletion } from './linking-service'
import { getCrdtProvider } from './crdt-provider'
import { clearInMemoryAuthState } from '../ipc/sync-core-handlers'
import { getDatabase, isDatabaseInitialized } from '../database/client'
import { store } from '../store'
import { createLogger } from '../lib/logger'
import { disconnectGoogleCalendar, listGoogleAccountIds } from '../calendar/google/oauth'
import { stopGoogleCalendarSyncRunner } from '../calendar/google/sync-service'

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
  // This install stops syncing here. `stopSyncRuntime` deliberately does not
  // clear the flag — quit and vault switch stop the runtime on an install that
  // still syncs — so sign-out is where it is cleared (#1579).
  markSyncIneligible()
  resetTokenManagerState()
  stopGoogleCalendarSyncRunner()

  if (reason === 'logout') {
    await revokeServerSession()
    if (isDatabaseInitialized()) {
      const db = getDatabase()
      const accountIds = listGoogleAccountIds(db)
      for (const accountId of accountIds) {
        try {
          await disconnectGoogleCalendar(accountId)
        } catch (err) {
          log.warn('Google Calendar disconnect failed during logout', { accountId, err })
        }
      }
    }
  }

  clearInMemoryAuthState()
  clearPendingSession()
  clearPendingLinkCompletion()

  const keychainEntries = [
    KEYCHAIN_ENTRIES.ACCESS_TOKEN,
    KEYCHAIN_ENTRIES.REFRESH_TOKEN,
    KEYCHAIN_ENTRIES.SETUP_TOKEN,
    KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY,
    // An 'integrity' teardown is triggered by checkSyncIntegrity finding the
    // DEVICE_SIGNING_KEY absent — a conclusion drawn from one keychain read that
    // may be wrong for reasons that have nothing to do with the master key (see
    // the v2026-08-06 safeStorage identity incident, where every read failed).
    // The master key is the one secret that cannot be re-issued by signing in
    // again, so it is never collateral: an explicit sign-out still clears it.
    ...(reason === 'integrity' ? [] : [KEYCHAIN_ENTRIES.MASTER_KEY])
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

  // Sign-out used to delete the whole CRDT store here. It no longer does.
  //
  // The store was global — one directory for every vault, keyed by note id —
  // so the wipe was containment for a collision that per-vault store paths now
  // make impossible (see crdt-store-path.ts). What it cost was the merge
  // history: the vault markdown survived a wipe, but with no local history
  // left, a note edited while signed out could not *merge* with the server's
  // version on sign-in — it could only be replaced by it, or re-seeded from
  // markdown as an independent insertion, which duplicates the body. Signing
  // out, editing, and signing back in silently lost the edit.
  //
  // stopSyncRuntime() above already destroyed and reset the provider, so the
  // store has to be reopened or the editor stays unbound to any Y.Doc until the
  // app restarts. Editing is never gated on session state — it stays fully
  // available signed out, offline, and with no account at all — so every reason
  // that leaves the app running has to put the store back. That is 'logout' and
  // 'integrity' alike: an integrity teardown is an involuntary sign-out the user
  // did not ask for, so leaving *it* with a dead provider is the worse of the
  // two. Note that getCrdtProvider() is called here, after stopSyncRuntime()
  // reset the singleton, so this opens the fresh instance rather than reviving
  // the destroyed one.
  //
  // 'shutdown' is the exception, and the only one: the app is quitting, so
  // there is no editor left to serve, and reopening would resolve the vault
  // uuid out of a data DB that closeVault() is about to close and leave a
  // freshly opened LevelDB store behind on the way out.
  if (reason !== 'shutdown') {
    void getCrdtProvider()
      .initPersistence()
      .catch((err) => log.warn('CRDT persistence re-init after session teardown failed', err))
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
