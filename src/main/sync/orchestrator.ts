/**
 * Sync Orchestrator
 *
 * Initializes sync subsystems and triggers sync on queue changes.
 *
 * @module sync/orchestrator
 */

import { initSyncEngine, getSyncEngine, type SyncEngine } from './engine'
import type { SyncStatusChangedEvent } from '@shared/contracts/ipc-sync'
import { initSyncQueue, getSyncQueue } from './queue'
import { getNetworkMonitor } from './network'
import { bootstrapSyncData } from './bootstrap'
import { ensureSyncAuthReady, initAuthSyncBridge, handleSessionExpired } from './auth-bridge'
import { registerDecryptedItemListener } from '../ipc/sync-handlers'
import { getCrdtProvider } from './crdt-provider'
import { initializeCrdtSyncBridge, getCrdtSyncBridge } from './crdt-sync-bridge'
import { initWebSocketManager, getWebSocketManager } from './websocket'

const AUTO_SYNC_DEBOUNCE_MS = 1500

let initialized = false
let autoSyncTimer: ReturnType<typeof setTimeout> | null = null
let autoSyncRunning = false

const ENGINE_IDLE_TIMEOUT_MS = 30_000

function waitForEngineIdle(engine: SyncEngine): Promise<void> {
  if (!engine.isSyncing) return Promise.resolve()
  return new Promise((resolve) => {
    const handler = (event: SyncStatusChangedEvent): void => {
      if (event.currentStatus === 'idle' || event.currentStatus === 'error') {
        engine.off('sync:status-changed', handler)
        resolve()
      }
    }
    engine.on('sync:status-changed', handler)
    setTimeout(() => {
      engine.off('sync:status-changed', handler)
      resolve()
    }, ENGINE_IDLE_TIMEOUT_MS)
  })
}

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

  const authReady = await ensureSyncAuthReady()
  if (!authReady) {
    return { ok: false, reason: 'auth-not-ready' }
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
    if (forcePull) {
      await engine.sync()
    } else {
      await engine.sync({ skipPull: true })
    }
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

  const serverUrl = process.env.SYNC_SERVER_URL || 'http://localhost:8787'
  initWebSocketManager({ serverUrl })
  console.info('[Sync] WebSocket manager initialized')

  await initSyncEngine()

  registerDecryptedItemListener()

  const networkMonitor = getNetworkMonitor()
  networkMonitor.start()
  networkMonitor.on('sync:online', () => {
    console.info('[Sync] Network online, triggering catch-up sync')
    void (async () => {
      try {
        const engine = getSyncEngine()
        if (engine?.isSyncing) {
          console.info('[Sync] Waiting for engine handleOnline sync to complete')
          await waitForEngineIdle(engine)
        }
        const crdtBridge = getCrdtSyncBridge()
        if (crdtBridge) {
          await crdtBridge.syncUnsyncedLocalDocs()
        }
        await runSync('network-online', true)
        if (crdtBridge) {
          await crdtBridge.syncAllDocs()
        }
      } catch (error) {
        console.warn('[Sync] Network online sync failed:', error)
      }
    })()
  })

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

  const wsManager = getWebSocketManager()
  if (wsManager) {
    wsManager.on('sync:ws-connected', () => {
      console.info('[Sync] WebSocket connected')
    })
    wsManager.on('sync:ws-disconnected', (code, reason) => {
      console.info('[Sync] WebSocket disconnected:', { code, reason })
    })
    wsManager.on('sync:ws-error', (error) => {
      console.error('[Sync] WebSocket error:', error.message)
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
  const authReady = await ensureSyncAuthReady()
  if (authReady) {
    // Bootstrap local data first (pushes existing content), then sync
    void (async () => {
      try {
        const bootstrapResult = await bootstrapSyncData()
        console.info('[Sync] Bootstrap complete', bootstrapResult)

        const crdtBridge = getCrdtSyncBridge()
        if (crdtBridge) {
          await crdtBridge.syncUnsyncedLocalDocs()
        }
        await runSync('startup', true)
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
