import type { SyncQueueManager } from '@memry/sync-client/queue'
import type { NetworkMonitor } from '../network'
import type { WebSocketManager } from '../websocket'
import type { SyncWorkerBridge } from '../worker-bridge'
import type { ItemApplier } from '../apply-item'
import type { CrdtProvider } from '../crdt-provider'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
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
  LAST_CRDT_SWEEP_AT: 'lastCrdtSweepAt',
  /**
   * `'1'` while some note's server state is known-unmerged, `'0'` once none is.
   *
   * The set of *which* notes lives in `CrdtSyncCoordinator.unmergedRemoteNotes`
   * and is per session — `clearCaches()` empties it at teardown — so a quit
   * between a failed merge and the next launch used to leave the note looking
   * merged and therefore safe to snapshot. Only the boolean is persisted; the
   * ids are re-derived by the next vault-wide sweep, which flags every note it
   * queues. See `FullSyncRunner.crdtUnmergedStateUnknown`.
   *
   * A missing row reads as `'0'`, which is what every install written before
   * this key existed has and what a vault with nothing outstanding means.
   */
  CRDT_UNMERGED_DEBT: 'crdtUnmergedDebt',
  /**
   * Highest pack cursor covered by an unbroken run of fully-applied bootstrap
   * packs (#1840), counting from the oldest pack upward.
   *
   * Written INSIDE the page transaction that commits the entries it covers, so
   * an interrupted bootstrap resumes from a watermark that can never claim
   * coverage over a page that did not commit. It gates nothing but pack work:
   * `LAST_CURSOR` and the item-granular pull are untouched by it, so a device
   * that never sees a pack behaves exactly as it does today.
   *
   * A missing row reads as 0 — no pack coverage — which is what every install
   * written before this key existed has.
   */
  PACKS_APPLIED_THROUGH_CURSOR: 'packsAppliedThroughCursor'
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
// The server's MAX_CHANGES_LIMIT for GET /sync/changes. Pinning 100 here made
// a full sync spend 5x the requests on the 60/min `sync_changes` bucket for no
// benefit — a changes page is refs only (no payloads), so a bigger page costs
// almost nothing client-side. Payload fetching stays bounded regardless: the
// page's ids are pulled in POST /sync/pull slices of PULL_REQUEST_MAX_IDS.
export const PULL_PAGE_LIMIT = 500
// The server's PullRequestSchema caps `itemIds` at 100 per POST /sync/pull —
// exceeding it is a 400, so a changes page is always pulled in slices of this.
export const PULL_REQUEST_MAX_IDS = 100
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
/**
 * Concurrent snapshot-push REQUESTS while a push iteration flushes its creates.
 *
 * The unit changed. It used to be concurrent NOTES — `pushSnapshotForNote` per
 * note, one `POST /sync/crdt/snapshot` each — so at 5 a seeded vault spent one
 * ~750ms round trip per body and 100 bodies took 15 seconds. A request now
 * carries up to MAX_CRDT_SNAPSHOT_BATCH_ENTRIES (50) notes, so the old
 * arithmetic of "concurrency = notes in flight" no longer describes anything.
 *
 * What actually bounds the request rate now is the shape of the loop above,
 * not this number:
 *
 *   - `dedupedItems` is at most `pushBatchSize` (100) per iteration, so an
 *     iteration can produce at most ceil(100 / 50) = 2 snapshot requests;
 *   - iterations are strictly serial, and each one also waits on its own
 *     `POST /sync/push` round trip.
 *
 * So the ceiling is ~2 `crdt_push` requests per serial iteration. Even at an
 * implausible one iteration per second that is 120 req/min against the
 * server's 300/min `crdt_push` bucket (sync.ts, keyed per device) — 40%, inside
 * the same 50% margin the sweep pacing below is derived against, with the
 * remainder left for the traffic that still pushes one note at a time: the 30s
 * snapshot scheduler, `close()`, `pushAllSnapshots`, `compactDoc` and the
 * pending-note replay.
 *
 * 4 is therefore headroom rather than a target — it covers `pushBatchSize`
 * growing to 200 without this becoming the limiter, and it is deliberately not
 * larger: every in-flight chunk holds up to 50 Y.Docs open across the request,
 * and the provider's inactive-doc LRU is 32, so a bigger number only buys more
 * eviction churn. If `pushBatchSize` or the batch cap moves far enough that
 * more than 4 chunks can exist at once, re-derive against the 300/min bucket
 * before raising this.
 *
 * It also still bounds the OLD-server path: against a server with no batch
 * endpoint each chunk falls back to one request per note, sent serially inside
 * the chunk, which is 4 requests in flight — the same order as the 5 this
 * replaced.
 */
export const CRDT_SNAPSHOT_CONCURRENCY = 4
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
// The pacing of the vault-wide CRDT catch-up sweep. These are the only thing
// keeping a whole-vault sweep under the server's rate limits, so they are set
// from those limits backwards.
//
// There are TWO independent budgets, and a sweep has to fit inside both:
//
//   GET  /sync/crdt/snapshot/:noteId  }  one `crdt_pull` bucket,
//   GET  /sync/crdt/updates           }  600 requests / 60 s
//   POST /sync/crdt/updates/batch        `crdt_batch_pull`, 30 requests / 60 s
//
// Both are keyed by deviceId, NOT by account (sync.ts:489-501), so a second
// device sweeping at the same time spends its own budget instead of eating into
// this one.
//
// MARGIN: never more than 50% of either bucket. The other half pays for editor
// traffic, the un-paced priority batch that jumps the queue for notes with a
// live editor, broadcast-driven single-note pulls, and a second sweep a flapping
// socket may start before the first has drained. So the ceilings this pacing is
// derived against are 300 GET/min and 15 POST/min, and the per-request time
// slices that produce them are
//
//   60_000 / 300 = 200 ms per snapshot GET   -> CRDT_SWEEP_MS_PER_SNAPSHOT_GET
//   60_000 /  15 =   4_000 ms per batch POST -> CRDT_SWEEP_MS_PER_BATCH_POST
//
// TWO PACES, NOT ONE. A chunk now runs in two phases that spend different
// buckets, and they cannot share a cadence:
//
//   - PROBE: one POST /sync/crdt/updates/batch for the whole chunk, `limit: 1`.
//     Spends `crdt_batch_pull` only. It opens no document and downloads no
//     snapshot, so the 32-doc LRU does not bound it and the only ceiling on its
//     size is the server's own 100-note cap on that endpoint's `notes` array
//     (CrdtBatchPullSchema, sync.ts). Hence CRDT_SWEEP_CHUNK_NOTES = 100.
//   - APPLY: for the notes the probe could not settle, open the doc, fetch the
//     snapshot baseline if it is not already the one in the doc, then loop the
//     batch endpoint for incrementals. Spends `crdt_pull` (one GET per note) and
//     `crdt_batch_pull` (one POST per round). It holds every one of its notes
//     open across an await, so it is hard-bounded by
//     `crdtProvider.inactiveDocCapacity` — 32 — and sub-chunks inside
//     `applyCrdtBatch` at that size.
//
// A single (chunk, interval) pair cannot serve both. 100 notes every 4 s is the
// right warm pace and 1,500 GET/min if the chunk turns out to be cold; 32 notes
// every 6.4 s is the right cold pace and takes a warm 1,000-note vault three and
// a half minutes to confirm nothing changed. So the interval is not fixed: a
// chunk is CHARGED for what it actually spent, and the next chunk waits until
// both buckets have earned it back —
//
//   delay = max(CRDT_SWEEP_CHUNK_INTERVAL_MS,
//               batchPosts    * CRDT_SWEEP_MS_PER_BATCH_POST,
//               snapshotGets  * CRDT_SWEEP_MS_PER_SNAPSHOT_GET)
//
// which is `crdtSweepChunkDelayMs` below, fed by the request counts
// `pullCrdtForNotes` returns. Both rates are then <= 50% by construction, in
// every regime, without the client having to know in advance which regime it is
// in — which it cannot, because that is what the probe is for.
//
// THE THREE REGIMES, V = 1,000 notes.
//
//   Warm (watermarks present, nothing changed remotely):
//     10 chunks x 100 notes. Each: 1 probe POST, 0 GETs, 0 docs opened.
//     delay = max(4_000, 1 x 4_000, 0) = 4 s
//     -> 15 POST/min = 50% of 30, 0 GET/min = 0% of 600, ~40 s wall clock.
//
//   Cold (first sync, or a store rebuilt/quarantined under this one):
//     10 chunks x 100 notes. No note has a watermark, so NO probe is sent at
//     all — that path costs exactly what it cost before the probe existed.
//     Each: 100 GETs + ceil(100/32) = 4 apply POSTs (at R = 1 round each).
//     delay = max(4_000, 4 x 4_000, 100 x 200) = 20 s
//     -> 300 GET/min = 50% of 600, 12 POST/min = 40% of 30, ~3 min 20 s.
//
//   Old server (no `snapshotMeta` in the batch response):
//     one wasted probe on the first chunk, then `snapshotMetaUnsupported`
//     latches and the arithmetic is the cold one exactly.
//
// Before this, at 25 notes / 15 s with an unconditional baseline, all three
// regimes were 100 GET/min, 4 POST/min and TEN MINUTES.
//
// THE POST COUNT IS A FLOOR, NOT AN EXACT COUNT, and that is why the counts are
// measured rather than predicted. `applyCrdtBatchChunk` loops while any note
// reports `hasMore`, so an apply sub-chunk costs one POST per round R. At R = 1
// the GET slice binds (20 s > 16 s); from R = 2 the POST slice binds
// (4R x 4_000 > 20_000 once R > 1.25) and the sweep slows down instead of
// bursting through the batch bucket. A fixed 6.4 s interval with R = 2 would
// have been 64 POSTs across 200 s = 19.2/min = 64% of the bucket — over the
// margin, silently. Charging the measured cost is what makes R > 1 safe.
//
// Only the RATE matters, not the total: cost per minute is CONSTANT in vault
// size, only the duration grows, so no vault can reproduce the
// 242-requests-in-4-seconds storm that had 92 of 121 notes come back "Too many
// requests" and silently keep stale bodies. For the same reason the per-note
// snapshot GETs inside a chunk stay SERIAL. Firing them in parallel is that
// storm, whatever the chunk size.
//
// Not all of the GET headroom is spare: the un-paced priority batch and the
// single-note pull path fetch snapshot baselines too, and those are `crdt_pull`
// GETs on this same bucket. The record-change pull, record pushes and
// attachment fetches are not — they meter under `sync_changes`, `sync_pull`,
// `sync_push` and `crdt_push`, which are separate keys with separate budgets.
//
// The sweep is PACED, never SELECTIVE. Every note in the vault is still named in
// every pass; these numbers decide what a note costs, never whether it is looked
// at. Note bodies never travel in the record change feed, so the sweep is the
// only channel by which a body-only remote edit reaches a device that missed the
// broadcast, and a note filtered out here would go stale with no second chance.

/**
 * Inactive-doc cache capacity while a bootstrap pull page's CRDT batch is
 * applied. The steady-state 32 splits every cold apply into 32-doc sub-chunks
 * (applyCrdtBatch sub-chunks at `inactiveDocCapacity`, because a sub-chunk
 * holds all of its docs open across the batch POST); at 128 the sub-chunk hits
 * the server's own 100-note batch ceiling instead, with headroom left over so
 * an editor doc opened mid-bootstrap does not push the cache over the limit
 * and evict docs the batch pass is still holding — the eviction that used to
 * clobber note bodies. ~128 open Y.Docs of ordinary notes is a few tens of MB;
 * the raise lives only for the duration of one page's CRDT batch and the
 * revert evicts (and flushes) back down to the steady-state limit.
 */
export const BOOTSTRAP_CRDT_INACTIVE_DOC_LIMIT = 128

/** Notes per paced sweep chunk = the server's cap on the probe POST's `notes` array. */
export const CRDT_SWEEP_CHUNK_NOTES = 100
/** Floor between chunks, and the poll interval while the drain is blocked (offline, fullSync active). */
export const CRDT_SWEEP_CHUNK_INTERVAL_MS = 4 * 1000
/** 60_000 / 200 = 300 GET/min = 50% of `crdt_pull`. */
export const CRDT_SWEEP_MS_PER_SNAPSHOT_GET = 200
/** 60_000 / 4_000 = 15 POST/min = 50% of `crdt_batch_pull`. */
export const CRDT_SWEEP_MS_PER_BATCH_POST = 4 * 1000

/** What one paced sweep chunk actually spent, per server rate-limit bucket. */
export interface CrdtPullCost {
  /** `GET /sync/crdt/snapshot/:noteId` attempts — the `crdt_pull` bucket. */
  snapshotGets: number
  /** `POST /sync/crdt/updates/batch` attempts, probe and apply rounds alike — `crdt_batch_pull`. */
  batchPosts: number
}

/**
 * How long the drain must wait after a chunk that spent `cost`.
 *
 * The chunk is charged to both buckets and the next one waits for the slower of
 * the two to earn it back, so neither rate can exceed its 50% margin whatever
 * mix of probe, baseline and apply rounds the chunk turned out to need. The
 * delay is measured from the chunk's COMPLETION, so the real period is the
 * chunk's own duration plus this — the rates below are ceilings, not targets.
 *
 * `elevationFactor` (#1837) divides every slice by the granted bootstrap
 * multiplier: the same 50%-margin discipline, applied against the ELEVATED
 * ceilings instead of the steady-state ones. It is read at charge time, so a
 * session that closes or expires reverts the very next chunk automatically;
 * clamped to >= 1 so a broken factor can only ever speed up toward — never
 * past — the conservative base.
 */
export const crdtSweepChunkDelayMs = (cost: CrdtPullCost, elevationFactor = 1): number => {
  const f =
    Number.isFinite(elevationFactor) && elevationFactor >= 1 ? Math.floor(elevationFactor) : 1
  return Math.max(
    Math.ceil(CRDT_SWEEP_CHUNK_INTERVAL_MS / f),
    Math.ceil((cost.batchPosts * CRDT_SWEEP_MS_PER_BATCH_POST) / f),
    Math.ceil((cost.snapshotGets * CRDT_SWEEP_MS_PER_SNAPSHOT_GET) / f)
  )
}

/**
 * Requests per minute a fresh device may spend on pack transfers (#1840),
 * before bootstrap elevation.
 *
 * Fed to the existing `DownloadPacer` rather than a second pacing mechanism, so
 * pack transfers back off through the same fixed-window machinery attachments
 * use, and the bootstrap session's factor widens the ceiling through the same
 * `setMultiplier` seam.
 *
 * A pack is one large object, not one small item: a bootstrap fetches tens of
 * files, not thousands, and each Range resume costs one more request. 60/min is
 * far more than a bootstrap can consume and still an actual ceiling if a
 * pathological resume loop ever develops.
 */
export const PACK_DOWNLOAD_MAX_REQUESTS_PER_MINUTE = 60

export const PUSH_DEBOUNCE_MS = 2000

export const yieldToEventLoop = (): Promise<void> => new Promise((r) => setImmediate(r))
