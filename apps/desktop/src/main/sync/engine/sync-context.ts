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
  calendarSyncOneSource?: (sourceId: string) => void
  /**
   * Does the local master key still match the account? Consulted when an
   * entire pull page fails to decrypt: 'mismatch' means the failures are a
   * vault-key problem, not per-item corruption, so quarantine/corrupt-marking
   * must be suppressed and the cycle stopped instead of branding every item.
   * 'transition' means key material is being re-established (sign-in /
   * recovery / linking mid-flight): stop the cycle quietly and let the flow
   * restart sync with the settled key.
   */
  checkAccountKey?: () => Promise<'match' | 'mismatch' | 'transition' | 'unknown'>
  /** Escalation for a CONFIRMED account-key mismatch (recovery prompt / sign-out). */
  onVaultKeyMismatch?: () => void
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
  QUARANTINED_ITEMS: 'quarantinedItems',
  LAST_MANIFEST_CHECK_AT: 'lastManifestCheckAt',
  LAST_CRDT_SWEEP_AT: 'lastCrdtSweepAt'
} as const

// Item ids are NOT unique across item types (default project id 'inbox', tag
// ids are tag names, folder_config ids are folder paths), so every piece of
// per-item sync bookkeeping must key on (type, id) — an id-only key makes a
// project and a tag named 'inbox' share one entry and corrupt each other's
// state (2026-07-18 incident).
export const itemRefKey = (itemType: string, itemId: string): string => `${itemType}:${itemId}`

export const PUSH_BATCH_SIZE = 100
export const MAX_PUSH_ITERATIONS = 50
export const CLOCK_SKEW_THRESHOLD_SECONDS = 300
export const PULL_PAGE_LIMIT = 100
export const CORRUPT_ITEM_COOLDOWN_MS = 60 * 60 * 1000
export const QUARANTINE_MAX_ATTEMPTS = 3
export const QUARANTINE_ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const STALE_CURSOR_THRESHOLD_MS = 24 * 60 * 60 * 1000
export const MAX_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000
export const BASE_RATE_LIMIT_BACKOFF_MS = 5_000
export const YIELD_EVERY_N_ITEMS = 20
export const CRDT_SNAPSHOT_CONCURRENCY = 5
// Fallback cadence for the vault-wide CRDT sweep at the end of fullSync, used
// ONLY when the socket cannot answer whether broadcasts were missed: no sweep
// recorded against the current engine yet (process start, vault switch, engine
// retry), or a socket that is down and has not reconnected. A live socket skips
// the sweep outright and a completed reconnect runs it immediately, so this
// number never gates the healthy path.
//
// It is deliberately not shorter. Where it does apply the device is receiving
// no broadcasts at all, which makes the sweep the sole discovery path for
// remote body edits — and each pass costs an HTTP round trip, a Y.Doc load and
// a keychain read per note in the vault. 15 minutes caps that at four passes an
// hour in the worst case (a socket blocked outright by a proxy) while keeping
// the blind window short enough to be invisible in normal use.
export const CRDT_FULL_SWEEP_MIN_INTERVAL_MS = 15 * 60 * 1000
export const PUSH_DEBOUNCE_MS = 2000

export const yieldToEventLoop = (): Promise<void> => new Promise((r) => setImmediate(r))
