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
/**
 * Hard cap on live corrupt-item cooldown entries.
 *
 * Each entry is only a (type, id) key plus two numbers, so 5,000 costs well
 * under a megabyte — but nothing bounded the map before, and a server-side
 * poisoned-payload event (2026-07-18 class) marks every item of a failing page
 * on every pull for a whole hour. Overflow evicts the oldest `failedAt` first:
 * those are the entries closest to expiring anyway, so the only thing an
 * eviction can cost is one extra re-fetch attempt for an item that was already
 * eligible to retry minutes later.
 */
export const MAX_CORRUPT_ITEMS = 5000
export const QUARANTINE_MAX_ATTEMPTS = 3
export const QUARANTINE_ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000
/**
 * Soft cap on in-memory quarantine entries.
 *
 * Deliberately soft: only entries below QUARANTINE_MAX_ATTEMPTS are evictable.
 * Those are pure attempt counters — losing one costs the item a fresh set of
 * attempts, and it re-quarantines within QUARANTINE_MAX_ATTEMPTS pulls if it is
 * still broken. Permanent entries are the record that keeps a failed-signature
 * item out of the vault, and `persistState()` serialises the map, so evicting
 * one would also erase it from disk. They are never evicted here; if a session
 * somehow accumulates more than this many permanent quarantines the map is
 * allowed to exceed the cap and the overflow is logged instead.
 */
export const MAX_QUARANTINE_ENTRIES = 10_000
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
// Floor between reconnect-triggered sweeps. A drop/reconnect is a real gap, so
// the sweep is genuinely owed — but a connection flapping every few seconds
// would otherwise buy one full O(vault) pass per flap, which is precisely the
// "one Wi-Fi blip = ~2,000 requests" storm this whole gate exists to remove.
// Inside the floor the sweep is deferred, never dropped.
//
// 60 seconds: long enough to collapse a flapping burst (drops re-establish in
// seconds) and to outlast a sweep of a large vault, so passes cannot overlap;
// short enough that a user who lost Wi-Fi and got it back sees another device's
// edits inside a minute. Unlike the fallback interval this one is only ever
// paid once per burst, so it does not need to be conservative.
export const CRDT_RECONNECT_SWEEP_FLOOR_MS = 60 * 1000
// How many notes one paced CRDT catch-up chunk pulls, and how long the next
// chunk waits. Together these are the only thing keeping a whole-vault sweep
// under the server's rate limits, so they are set from those limits backwards.
//
// There are TWO independent budgets, and a sweep has to fit inside both:
//
//   GET  /sync/crdt/snapshot/:noteId  }  one `crdt_pull` bucket,
//   GET  /sync/crdt/updates           }  300 requests / 60 s
//   POST /sync/crdt/updates/batch        `crdt_batch_pull`, 30 requests / 60 s
//
// Both are shared by every device on the account. One chunk of N notes through
// applyCrdtBatch costs N snapshot GETs — the batch endpoint batches the
// incrementals, NOT the snapshot baselines, which are still fetched one note at
// a time — plus at least one batch POST.
//
//   25 notes per chunk, 60_000 / 15_000 = 4 chunks per minute
//   GET  budget: 25 x 4 = 100/min per sweeping device, 200 for two devices,
//                against 300 — the binding constraint, ~30% spare
//   POST budget:  1 x 4 =   4/min per sweeping device,   8 for two devices,
//                against 30 — 7.5x headroom on a single device
//
// Only the RATE matters, not the total: a 1,000-note vault is 40 chunks and 40
// batch POSTs, which would blow the 30/60s batch bucket if fired at once but is
// 4/min spread across the ten minutes the paced sweep takes. That is the whole
// point of pacing — cost per minute is CONSTANT in vault size, only the duration
// grows, so no vault can reproduce the 242-requests-in-4-seconds storm that had
// 92 of 121 notes coming back "Too many requests" and silently keeping stale
// bodies. Slow is the correct trade: this is a catch-up, not a race, and the
// notes the user actually has open skip the queue entirely.
//
// The POST figure is a floor, not an exact count: applyCrdtBatchChunk loops
// while any note reports `hasMore`, so a chunk costs one POST per round. The
// batch budget only binds if chunks average more than seven rounds — i.e. over
// 700 queued updates spread across one chunk's notes, which is a first-sync
// backlog, not steady state. It is also no longer destructive if it happens: a
// rate-limited batch re-queues its whole chunk for the next cycle instead of
// dropping it.
//
// The GET headroom is not spare either — the record-change pull, pushes,
// attachment fetches and the un-paced priority batch all draw on the same 300.
export const CRDT_SWEEP_CHUNK_NOTES = 25
export const CRDT_SWEEP_CHUNK_INTERVAL_MS = 15 * 1000
export const PUSH_DEBOUNCE_MS = 2000

export const yieldToEventLoop = (): Promise<void> => new Promise((r) => setImmediate(r))
