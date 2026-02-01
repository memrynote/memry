/**
 * Sync Orchestrator
 *
 * Initializes sync subsystems and triggers sync on queue changes.
 *
 * @module sync/orchestrator
 */

import { initSyncEngine, getSyncEngine } from './engine'
import { initSyncQueue, getSyncQueue } from './queue'
import { getNetworkMonitor } from './network'
import { retrieveAuthTokens, retrieveKeyMaterial } from '../crypto/keychain'
import { bootstrapSyncData } from './bootstrap'
import { initAuthSyncBridge, handleSessionExpired } from './auth-bridge'
import { getSyncUserId } from './auth-state'
import { registerDecryptedItemListener } from '../ipc/sync-handlers'
import { getCrdtProvider } from './crdt-provider'
import { initializeCrdtSyncBridge, getCrdtSyncBridge } from './crdt-sync-bridge'

const AUTO_SYNC_DEBOUNCE_MS = 1500

let initialized = false
let autoSyncTimer: ReturnType<typeof setTimeout> | null = null
let autoSyncRunning = false

async function canSync(): Promise<{ ok: boolean; reason?: string }> {
  const engine = getSyncEngine()
  if (!engine) {
    return { ok: false, reason: 'engine-not-ready' }
  }
  if (engine.isSyncing) {
    return { ok: false, reason: 'engine-busy' }
  }
  if (engine.status === 'paused') {
    return { ok: false, reason: 'engine-paused' }
  }

  const networkMonitor = getNetworkMonitor()
  if (!networkMonitor.isOnline()) {
    return { ok: false, reason: 'offline' }
  }

  try {
    const [tokens, keyMaterial] = await Promise.all([retrieveAuthTokens(), retrieveKeyMaterial()])

    if (!tokens?.accessToken) {
      return { ok: false, reason: 'missing-auth-token' }
    }

    if (!keyMaterial?.masterKey) {
      return { ok: false, reason: 'missing-key-material' }
    }
  } catch {
    return { ok: false, reason: 'auth-check-failed' }
  }

  return { ok: true }
}

async function runSync(reason: string, forcePull: boolean): Promise<void> {
  if (autoSyncRunning) return

  const engine = getSyncEngine()
  if (!engine) return

  const eligibility = await canSync()
  if (!eligibility.ok) {
    console.info('[Sync] Auto sync skipped', { reason, detail: eligibility.reason })
    return
  }

  const queue = getSyncQueue()
  if (!forcePull && queue.isEmpty()) {
    console.info('[Sync] Auto sync skipped: queue empty', { reason })
    return
  }

  autoSyncRunning = true
  try {
    console.info('[Sync] Auto sync starting', {
      reason,
      forcePull,
      queueSize: queue.size()
    })
    await engine.sync()
    console.info('[Sync] Auto sync finished', { reason })
  } catch (error) {
    console.warn(`[Sync] Auto sync failed (${reason}):`, error)
  } finally {
    autoSyncRunning = false
  }
}

function scheduleAutoSync(reason: string): void {
  if (autoSyncTimer) {
    clearTimeout(autoSyncTimer)
  }
  console.info('[Sync] Auto sync scheduled', { reason })
  autoSyncTimer = setTimeout(() => {
    void runSync(reason, false)
  }, AUTO_SYNC_DEBOUNCE_MS)
}

/**
 * Initialize sync subsystems (queue, engine, network monitor) and auto-sync hooks.
 */
export async function initSyncSubsystem(): Promise<void> {
  if (initialized) return

  console.info('[Sync] Initializing sync subsystem')
  await initSyncQueue()
  await initSyncEngine()

  registerDecryptedItemListener()

  const networkMonitor = getNetworkMonitor()
  networkMonitor.start()

  const queue = getSyncQueue()
  console.info('[Sync] Queue loaded', { count: queue.size() })
  queue.on('sync:queue-changed', (count) => {
    console.info('[Sync] Queue changed', { count })
    scheduleAutoSync('queue-changed')
  })
  queue.on('sync:item-added', (item) => {
    console.info('[Sync] Queue item added', {
      itemId: item.itemId,
      itemType: item.type,
      operation: item.operation
    })
  })
  queue.on('sync:item-updated', (item) => {
    console.info('[Sync] Queue item updated', {
      itemId: item.itemId,
      itemType: item.type,
      operation: item.operation,
      attempts: item.attempts
    })
  })
  queue.on('sync:item-removed', (id) => {
    console.info('[Sync] Queue item removed', { id })
  })

  const engine = getSyncEngine()
  if (engine) {
    engine.on('sync:session-expired', () => {
      console.info('[Sync] Session expired event received')
      handleSessionExpired()
    })
  }

  await initAuthSyncBridge()

  // Initialize CRDT sync bridge if CrdtProvider is available
  const crdtProvider = getCrdtProvider()
  if (crdtProvider) {
    const crdtBridge = initializeCrdtSyncBridge()
    crdtBridge.initialize(crdtProvider)
    crdtProvider.setSyncBridge(crdtBridge)
    console.info('[Sync] CRDT sync bridge initialized')
  }

  // Sync on startup only if session is valid
  if (getSyncUserId()) {
    // Bootstrap local data first (pushes existing content), then sync
    void (async () => {
      try {
        const bootstrapResult = await bootstrapSyncData()
        console.info('[Sync] Bootstrap complete', bootstrapResult)

        // After bootstrap, run regular sync (push remaining queue + pull remote changes)
        await runSync('startup', true)

        // Pull CRDT updates for any remote notes we don't have locally
        const crdtBridge = getCrdtSyncBridge()
        if (crdtBridge) {
          await crdtBridge.syncAllDocs()
        }
      } catch (error) {
        console.warn('[Sync] Startup sync failed:', error)
      }
    })()
  } else {
    console.info('[Sync] Startup sync skipped: no valid session')
  }

  initialized = true
}
