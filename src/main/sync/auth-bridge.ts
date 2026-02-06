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
import { getDatabase } from '../database'
import { getSetting } from '@shared/db/queries/settings'
import { queueLocalChangesSinceLastSync } from './local-changes'
import { bootstrapSyncData } from './bootstrap'
import { getSyncUserId, setSyncAuthState, SYNC_SETUP_PENDING_KEY } from './auth-state'
import { refreshAccessToken } from './token-refresh'
import { isAccessTokenExpired } from './token-utils'
import { getCrdtSyncBridge, initializeCrdtSyncBridge, type CrdtSyncBridge } from './crdt-sync-bridge'
import { getCrdtProvider } from './crdt-provider'
import { getWebSocketManager } from './websocket'

const LOG_PREFIX = '[AuthSyncBridge]'

let initialized = false
let pendingSync = false
let deferredSyncInFlight: Promise<void> | null = null

const ENGINE_UNLOCK_TIMEOUT_MS = 1500
const ENGINE_UNLOCK_POLL_MS = 25

type StoredAuthTokens = Awaited<ReturnType<typeof retrieveAuthTokens>>

function readSyncSetupComplete(): boolean {
  try {
    const db = getDatabase()
    const pending = getSetting(db, SYNC_SETUP_PENDING_KEY)
    if (pending) {
      return false
    }
    return true
  } catch {
    return false
  }
}

async function getFreshAuthTokens(
  initialTokens?: StoredAuthTokens | null
): Promise<StoredAuthTokens | null> {
  let tokens = initialTokens ?? (await retrieveAuthTokens().catch(() => null))

  if (!tokens?.accessToken) {
    return null
  }

  if (!isAccessTokenExpired(tokens.accessToken)) {
    return tokens
  }

  const networkMonitor = getNetworkMonitor()
  if (!networkMonitor.isOnline()) {
    console.info(`${LOG_PREFIX} Access token expired while offline`)
    return null
  }

  console.info(`${LOG_PREFIX} Access token expired, attempting refresh`)
  const refreshed = await refreshAccessToken().catch(() => false)
  if (!refreshed) {
    return null
  }

  tokens = await retrieveAuthTokens().catch(() => null)
  if (!tokens?.accessToken || isAccessTokenExpired(tokens.accessToken)) {
    return null
  }

  return tokens
}

export async function ensureSyncAuthReady(): Promise<boolean> {
  const setupComplete = readSyncSetupComplete()
  const keyMaterial = await retrieveKeyMaterial().catch(() => null)
  const storedTokens = await retrieveAuthTokens().catch(() => null)
  const tokens = await getFreshAuthTokens(storedTokens)
  const userId = tokens?.userId ?? storedTokens?.userId ?? null

  const authReady = !!tokens?.accessToken && !!keyMaterial?.masterKey
  setSyncAuthState({
    userId,
    authReady,
    syncEnabled: setupComplete
  })

  return authReady && setupComplete && !!userId
}

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

async function triggerSync(): Promise<boolean> {
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
    return false
  }

  const engine = getSyncEngine()
  if (!engine) return false

  console.info(`${LOG_PREFIX} Triggering sync after authentication`)
  try {
    const result = await engine.sync()
    console.info(`${LOG_PREFIX} Post-auth sync completed`, { pushed: result.pushed, pulled: result.pulled })
    return result.pushed
  } catch (error) {
    console.warn(`${LOG_PREFIX} Post-auth sync failed:`, error)
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForEngineUnlock(timeoutMs = ENGINE_UNLOCK_TIMEOUT_MS): Promise<void> {
  const startedAt = Date.now()
  while (true) {
    const engine = getSyncEngine()
    if (!engine || !engine.isSyncing) {
      return
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return
    }
    await delay(ENGINE_UNLOCK_POLL_MS)
  }
}

async function syncUnsyncedDocsIfEngineIdle(): Promise<void> {
  const crdtBridge = ensureCrdtSyncBridge()
  if (!crdtBridge) {
    console.info(`${LOG_PREFIX} CRDT unsynced sync skipped: bridge unavailable`)
    return
  }

  const engine = getSyncEngine()
  if (engine?.isSyncing) {
    if (!pendingSync) {
      console.info(`${LOG_PREFIX} CRDT unsynced sync deferred: engine busy`)
    }
    pendingSync = true
    return
  }

  await crdtBridge.syncUnsyncedLocalDocs()
}

function ensureCrdtSyncBridge(): CrdtSyncBridge | null {
  const existing = getCrdtSyncBridge()
  if (existing) {
    return existing
  }

  const crdtProvider = getCrdtProvider()
  if (!crdtProvider) {
    return null
  }

  const bridge = initializeCrdtSyncBridge()
  bridge.initialize(crdtProvider)
  crdtProvider.setSyncBridge(bridge)
  console.info(`${LOG_PREFIX} CRDT sync bridge initialized on demand`)
  return bridge
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

  const previousUserId = getSyncUserId()

  if (previousUserId && previousUserId !== userId) {
    console.info(`${LOG_PREFIX} User changed from ${previousUserId} to ${userId}, clearing queue`)
    const queue = getSyncQueue()
    await queue.clearForUserChange(previousUserId, userId)
  }

  console.info(`${LOG_PREFIX} Session changed, user:`, userId)

  const [tokens, keyMaterial] = await Promise.all([
    retrieveAuthTokens().catch(() => null),
    retrieveKeyMaterial().catch(() => null)
  ])
  const setupComplete = readSyncSetupComplete()
  setSyncAuthState({
    userId,
    authReady: !!tokens?.accessToken && !!keyMaterial?.masterKey,
    syncEnabled: setupComplete
  })

  if (!setupComplete) {
    console.info(`${LOG_PREFIX} Sync deferred: setup not confirmed yet`)
    return
  }

  await bootstrapSyncData()
  await queueLocalChangesSinceLastSync()
  await triggerSync()
  await syncUnsyncedDocsIfEngineIdle()
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

  pendingSync = false
  setSyncAuthState({ userId: null, authReady: false, syncEnabled: false })
}

/**
 * Get the stored user ID from the last successful authentication.
 * Used for user change detection.
 */
/**
 * Trigger sync after crypto setup completes.
 * Called after storeKeyMaterial() in sync-handlers.ts.
 * At this point, both auth tokens and key material are available.
 */
export async function triggerPostSetupSync(): Promise<void> {
  console.info(`${LOG_PREFIX} Crypto setup complete, triggering sync`)

  const [tokens, keyMaterial] = await Promise.all([
    retrieveAuthTokens().catch(() => null),
    retrieveKeyMaterial().catch(() => null)
  ])

  setSyncAuthState({
    userId: tokens?.userId ?? getSyncUserId(),
    authReady: !!tokens?.accessToken && !!keyMaterial?.masterKey
  })

  await bootstrapSyncData()
  await queueLocalChangesSinceLastSync()
  await triggerSync()
  await syncUnsyncedDocsIfEngineIdle()
}

/**
 * Initialize the auth-sync bridge.
 * Sets up event listeners and loads the last known user ID from keychain.
 * Should be called during sync subsystem initialization.
 */
export async function initAuthSyncBridge(): Promise<void> {
  if (initialized) return

  const storedTokens = await retrieveAuthTokens().catch(() => null)
  const tokens = await getFreshAuthTokens(storedTokens)
  const keyMaterial = await retrieveKeyMaterial().catch(() => null)

  if (storedTokens?.userId) {
    if (tokens) {
      console.info(`${LOG_PREFIX} Found stored session for user:`, storedTokens.userId)
    } else {
      console.info(
        `${LOG_PREFIX} Stored session found but access token expired or invalid`,
        storedTokens.userId
      )
    }
  } else {
    console.info(`${LOG_PREFIX} No stored session`)
  }

  console.info(`${LOG_PREFIX} Token state:`, {
    hasStoredTokens: !!storedTokens,
    hasFreshTokens: !!tokens,
    hasAccessToken: !!tokens?.accessToken,
    wsManagerState: getWebSocketManager()?.state ?? 'not-initialized'
  })

  const setupComplete = readSyncSetupComplete()
  const authReady = !!tokens?.accessToken && !!keyMaterial?.masterKey && setupComplete

  setSyncAuthState({
    userId: tokens?.userId ?? storedTokens?.userId ?? null,
    authReady: !!tokens?.accessToken && !!keyMaterial?.masterKey,
    syncEnabled: setupComplete
  })

  if (tokens?.accessToken) {
    const wsManager = getWebSocketManager()
    if (wsManager && wsManager.state === 'disconnected') {
      console.info(`${LOG_PREFIX} Connecting WebSocket`)
      wsManager.connect(tokens.accessToken).catch((error) => {
        console.warn(`${LOG_PREFIX} WebSocket connection failed:`, error)
      })
    }
  }

  if (authReady) {
    const crdtBridge = ensureCrdtSyncBridge()
    if (crdtBridge) {
      console.info(`${LOG_PREFIX} Auth ready on init, syncing unsynced local docs`)
      void syncUnsyncedDocsIfEngineIdle()
    }
  }

  const engine = getSyncEngine()
  if (engine) {
    engine.on('sync:status-changed', (event) => {
      if (event.previousStatus === 'syncing' && event.currentStatus === 'idle') {
        if (deferredSyncInFlight) {
          return
        }

        deferredSyncInFlight = (async () => {
          await waitForEngineUnlock()

          const crdtBridge = ensureCrdtSyncBridge()
          if (crdtBridge) {
            await crdtBridge.retryPendingSnapshots()
          }

          if (!pendingSync) return

          pendingSync = false
          console.info(`${LOG_PREFIX} Previous sync completed, triggering deferred sync`)
          const queue = getSyncQueue()
          if (queue.isEmpty()) {
            console.info(`${LOG_PREFIX} Deferred metadata sync skipped: queue empty`)
          } else {
            await triggerSync()
          }
          await syncUnsyncedDocsIfEngineIdle()
        })()
          .catch((error) => {
            console.warn(`${LOG_PREFIX} Deferred sync processing failed:`, error)
          })
          .finally(() => {
            deferredSyncInFlight = null
          })
      }
    })
  }

  initialized = true
  console.info(`${LOG_PREFIX} Initialized`)
}
