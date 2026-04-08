import type { SyncQueueManager } from '../queue'
import type { NetworkMonitor } from '../network'
import type { WebSocketManager } from '../websocket'
import type { SyncWorkerBridge } from '../worker-bridge'
import type { ItemApplier } from '../apply-item'
import type { CrdtProvider } from '../crdt-provider'
import type { DrizzleDb } from '../item-handlers/types'
import type { SyncAdapterRegistry } from '@memry/sync-core'
import type { SyncStatusValue } from '@memry/contracts/ipc-sync-ops'
import type { SyncErrorInfo } from '../sync-errors'

export interface SyncEngineDeps {
  queue: SyncQueueManager
  network: NetworkMonitor
  ws: WebSocketManager
  getAccessToken: () => Promise<string | null>
  getVaultKey: () => Promise<Uint8Array | null>
  getSigningKeys: () => Promise<{
    secretKey: Uint8Array
    publicKey: Uint8Array
    deviceId: string
  } | null>
  getDevicePublicKey: (deviceId: string) => Promise<Uint8Array | null>
  db: DrizzleDb
  emitToRenderer: (channel: string, data: unknown) => void
  adapters?: SyncAdapterRegistry<DrizzleDb, (channel: string, data: unknown) => void>
  crdtProvider?: CrdtProvider
  workerBridge?: SyncWorkerBridge
  refreshAccessToken?: () => Promise<boolean>
}

export interface SyncEngineOptions {
  pushBatchSize: number
  pullPageLimit: number
}

export interface QuarantineEntry {
  itemId: string
  itemType: string
  signerDeviceId: string
  failedAt: number
  attemptCount: number
  lastError: string
}

export interface SyncContext {
  deps: SyncEngineDeps
  options: SyncEngineOptions
  applier: ItemApplier

  state: SyncStatusValue
  syncing: boolean
  fullSyncActive: boolean
  abortController: AbortController | null
  inFlightSync: Promise<void> | null
  lastError: string | undefined
  lastErrorInfo: SyncErrorInfo | undefined
  offlineSince: number | null
  rateLimitConsecutive: number

  scheduleSync: (fn: () => Promise<void>) => void
  acquireLock: () => Promise<(() => void) | null>
  releaseLock: () => void
  requestPush: () => void
  doPush?: () => Promise<void>
}

export const SYNC_STATE_KEYS = {
  LAST_CURSOR: 'lastCursor',
  LAST_SYNC_AT: 'lastSyncAt',
  SYNC_PAUSED: 'syncPaused',
  INITIAL_SEED_DONE: 'initialSeedDone',
  QUARANTINED_ITEMS: 'quarantinedItems'
} as const

export const PUSH_BATCH_SIZE = 100
export const MAX_PUSH_ITERATIONS = 50
export const CLOCK_SKEW_THRESHOLD_SECONDS = 300
export const PULL_PAGE_LIMIT = 100
export const CORRUPT_ITEM_COOLDOWN_MS = 60 * 60 * 1000
export const QUARANTINE_MAX_ATTEMPTS = 3
export const STALE_CURSOR_THRESHOLD_MS = 24 * 60 * 60 * 1000
export const MAX_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000
export const BASE_RATE_LIMIT_BACKOFF_MS = 5_000
export const YIELD_EVERY_N_ITEMS = 20
export const CRDT_SNAPSHOT_CONCURRENCY = 5
export const PUSH_DEBOUNCE_MS = 2000

export const yieldToEventLoop = (): Promise<void> => new Promise((r) => setImmediate(r))
