/**
 * Auth-Sync Bridge
 *
 * Coordinates between authentication state changes and the sync subsystem.
 * Triggers sync operations when users sign in and handles user change detection.
 *
 * @module sync/auth-bridge
 */

import { getSyncEngine } from './engine'
import { getSyncQueue } from './queue'
import { getNetworkMonitor } from './network'
import { retrieveAuthTokens, retrieveKeyMaterial } from '../crypto/keychain'
import { queueLocalChangesSinceLastSync } from './local-changes'

const LOG_PREFIX = '[AuthSyncBridge]'

let lastKnownUserId: string | null = null
let initialized = false
let pendingSync = false

async function canTriggerSync(): Promise<{ ok: boolean; reason?: string }> {
  const engine = getSyncEngine()
  if (!engine) {
    return { ok: false, reason: 'engine-not-ready' }
  }

  if (engine.isSyncing) {
    return { ok: false, reason: 'engine-busy' }
  }

  const networkMonitor = getNetworkMonitor()
  if (!networkMonitor.isOnline()) {
    return { ok: false, reason: 'offline' }
  }

  try {
    const keyMaterial = await retrieveKeyMaterial()
    if (!keyMaterial?.masterKey) {
      return { ok: false, reason: 'missing-key-material' }
    }
  } catch {
    return { ok: false, reason: 'key-check-failed' }
  }

  return { ok: true }
}

async function triggerSync(): Promise<void> {
  const eligibility = await canTriggerSync()

  if (!eligibility.ok) {
    if (eligibility.reason === 'engine-busy') {
      pendingSync = true
      console.info(`${LOG_PREFIX} Sync deferred: engine busy, will retry after current sync`)
    } else if (eligibility.reason === 'offline') {
      console.info(`${LOG_PREFIX} Sync deferred: offline, network monitor will trigger when online`)
    } else {
      console.info(`${LOG_PREFIX} Sync skipped:`, eligibility.reason)
    }
    return
  }

  const engine = getSyncEngine()
  if (!engine) return

  console.info(`${LOG_PREFIX} Triggering sync after authentication`)
  try {
    await engine.sync()
    console.info(`${LOG_PREFIX} Post-auth sync completed`)
  } catch (error) {
    console.warn(`${LOG_PREFIX} Post-auth sync failed:`, error)
  }
}

/**
 * Handle authentication session change.
 * Called after successful login (OTP or OAuth).
 *
 * @param isAuthenticated - Whether user is now authenticated
 * @param userId - The authenticated user's ID (required when isAuthenticated is true)
 */
export async function handleSessionChanged(
  isAuthenticated: boolean,
  userId?: string
): Promise<void> {
  if (!isAuthenticated) {
    handleSessionExpired()
    return
  }

  if (!userId) {
    console.warn(
      `${LOG_PREFIX} handleSessionChanged called with isAuthenticated=true but no userId`
    )
    return
  }

  const previousUserId = lastKnownUserId

  if (previousUserId && previousUserId !== userId) {
    console.info(`${LOG_PREFIX} User changed from ${previousUserId} to ${userId}, clearing queue`)
    const queue = getSyncQueue()
    await queue.clearForUserChange(previousUserId, userId)
  }

  lastKnownUserId = userId
  console.info(`${LOG_PREFIX} Session changed, user:`, userId)

  await queueLocalChangesSinceLastSync()
  await triggerSync()
}

/**
 * Handle session expiration or logout.
 * Pauses sync operations until user re-authenticates.
 */
export function handleSessionExpired(): void {
  console.info(`${LOG_PREFIX} Session expired or user logged out`)

  const engine = getSyncEngine()
  if (engine) {
    engine.pause()
  }

  lastKnownUserId = null
  pendingSync = false
}

/**
 * Get the stored user ID from the last successful authentication.
 * Used for user change detection.
 */
export function getStoredUserId(): string | null {
  return lastKnownUserId
}

/**
 * Trigger sync after crypto setup completes.
 * Called after storeKeyMaterial() in sync-handlers.ts.
 * At this point, both auth tokens and key material are available.
 */
export async function triggerPostSetupSync(): Promise<void> {
  console.info(`${LOG_PREFIX} Crypto setup complete, triggering sync`)

  try {
    const tokens = await retrieveAuthTokens()
    if (tokens?.userId) {
      lastKnownUserId = tokens.userId
    }
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to update user ID after setup:`, error)
  }

  await queueLocalChangesSinceLastSync()
  await triggerSync()
}

/**
 * Initialize the auth-sync bridge.
 * Sets up event listeners and loads the last known user ID from keychain.
 * Should be called during sync subsystem initialization.
 */
export async function initAuthSyncBridge(): Promise<void> {
  if (initialized) return

  try {
    const tokens = await retrieveAuthTokens()
    if (tokens?.userId) {
      lastKnownUserId = tokens.userId
      console.info(`${LOG_PREFIX} Loaded last known user ID:`, lastKnownUserId)
    }
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to load last known user ID:`, error)
  }

  const engine = getSyncEngine()
  if (engine) {
    engine.on('sync:status-changed', (event) => {
      if (event.previousStatus === 'syncing' && event.currentStatus === 'idle' && pendingSync) {
        pendingSync = false
        console.info(`${LOG_PREFIX} Previous sync completed, triggering deferred sync`)
        void triggerSync()
      }
    })
  }

  initialized = true
  console.info(`${LOG_PREFIX} Initialized`)
}
