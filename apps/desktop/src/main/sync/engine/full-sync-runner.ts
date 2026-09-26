import { createLogger } from '../../lib/logger'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import type { InitialSyncProgressEvent } from '@memry/contracts/ipc-events'
import { ERROR_RETENTION_DAYS } from '@memry/sync-client/queue'
import { abandonBootstrap, beginBootstrap, markBootstrapFullText } from '../bootstrap-metrics'
import { closeBootstrapSession, openBootstrapSession } from '../bootstrap-session'
import { getBootstrapElevationFactor } from '../bootstrap-session-state'
import { checkManifestIntegrity } from '../manifest-check'
import { runInitialSeed } from '../initial-seed'
import { trackMainEvent } from '../../telemetry/track'
import type { SyncContext } from './sync-context'
import {
  CRDT_SWEEP_CHUNK_INTERVAL_MS,
  CRDT_SWEEP_CHUNK_NOTES,
  crdtSweepChunkDelayMs,
  NOTE_BODY_LEGACY_SWEEP_DONE,
  NOTE_BODY_LEGACY_SWEEP_PENDING,
  PACK_DOWNLOAD_MAX_REQUESTS_PER_MINUTE,
  SYNC_STATE_KEYS
} from './sync-context'
import type { SyncStateManager } from './sync-state-manager'
import type { PushCoordinator } from './push-coordinator'
import type { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import { CRDT_BODY_DEBT_MAX_BACKOFF_MS, convertUnmergedDebtMirror } from './crdt-body-debts'
import { getAllCrdtNoteIds, getAllSyncableNoteMetadataIds } from '../../database/queries/notes'
import { getIndexDatabase, isIndexDatabaseInitialized } from '../../database/client'
import { isKnownNote } from '../note-body-apply'

const log = createLogger('SyncEngine')

const CURSOR_SKIP_REPAIR_DONE = 'done'

/**
 * How long the paced CRDT drain must stay CONTINUOUSLY blocked before the
 * elevated bootstrap session is given up (#1837).
 *
 * Releasing on the first blocked tick was an unbounded regression. The session
 * is opened exactly once per vault, gated on `LAST_CURSOR == null`, and the
 * first pull page persists that cursor — so once it is released nothing
 * re-opens it, and the rest of the bootstrap drains at base pacing for the
 * whole run. A laptop lid, a wifi switch or a VPN reconnect lasting seconds
 * therefore cost the entire remaining drain its elevation factor, which on a
 * large vault turns minutes of chunk delay into tens of minutes — a permanent
 * slowdown of exactly the workload the session exists to accelerate.
 *
 * Two minutes is longer than every one of those transient shapes and still
 * ~3% of the session's <=60 minute server-side TTL, so a genuinely permanent
 * disconnect leaks an already-bounded slot for two minutes more than before.
 */
export const BOOTSTRAP_DRAIN_BLOCKED_DWELL_MS = 2 * 60 * 1000

/** How long a pull re-queued after a rate limit waits for another trigger (#2421). */
export const CRDT_REQUEUED_PULL_FLOOR_MS = 60 * 1000

export interface FullSyncActions {
  /**
   * Resolves TRUE only when the pull actually delivered. Every error path out
   * of a pull is swallowed (`SyncEngine.pull` catches everything,
   * `PullCoordinator.pull` returns early on a busy lock, missing credentials or
   * a refused page), so non-rejection is not evidence of anything (#1835).
   */
  pull: () => Promise<boolean>
  push: () => Promise<void>
  /** False when the engine dropped `fn` because a full sync is running. */
  scheduleSync: (fn: () => Promise<void>) => boolean
}

export class FullSyncRunner {
  private ctx: SyncContext
  private stateManager: SyncStateManager
  private pushCoordinator: PushCoordinator
  private crdtSync: CrdtSyncCoordinator
  private actions: FullSyncActions
  private isQuarantined?: (itemId: string, itemType: string) => boolean
  // In-memory cache of the persisted throttle timestamp. The persisted value
  // is the authority: this runner is recreated with every engine (vault
  // switch, restart, retry), and an instance-only field re-armed an immediate
  // manifest check each time — with a permanently quarantined item that meant
  // a cursor reset and full re-pull on every single sync cycle.
  lastManifestCheckAt = 0
  /**
   * Notes drained from the pending-pull set that are waiting their turn in a
   * paced catch-up chunk.
   *
   * A Set, so a note re-queued by a failed chunk cannot accumulate duplicates
   * across cycles — the queue stays bounded by the vault, not by how many times
   * the server has said no. Insertion order is preserved, so it still drains
   * FIFO — which makes insertion order the catch-up's priority: open-but-
   * inactive docs are spliced in at the front by `flushPendingCrdtPulls`, and
   * `getAllCrdtNoteIds` supplies the rest of the legacy sweep in
   * `modifiedAt DESC`. In-memory by design: this queue is a plan for the
   * current engine's catch-up, and the durable debts carry the work across a
   * restart.
   */
  private pacedCrdtPullQueue = new Set<string>()
  private pacedCrdtPullTimer: ReturnType<typeof setTimeout> | null = null
  /** Fires `flushPendingCrdtPulls` when the earliest deferred pull is due. */
  private deferredPullTimer: ReturnType<typeof setTimeout> | null = null
  private deferredPullTimerAt = 0
  /** Pays pulls re-queued after a failure that counted nothing (#2421). */
  private requeuedPullTimer: ReturnType<typeof setTimeout> | null = null
  /** Set by `dispose()`: no timer, flush or pump runs after the teardown. */
  private disposed = false
  private pacedCrdtChunkInFlight = false
  /**
   * Cancels the sweep's in-flight pulls when the engine goes away.
   *
   * Dropping the queue and the timer stops the NEXT chunk, but a paced sweep
   * spans minutes, so there is almost always a chunk already in flight — and
   * that one would run to completion against a provider and a vault this engine
   * no longer owns, opening docs on a discarded provider and spending request
   * budget for a session that is over. Rebuilt on demand, because an aborted
   * controller stays aborted and a later engine must not inherit it.
   */
  private pacedCrdtPullAbort: AbortController | null = null
  /**
   * This engine queued the one-time note-body legacy sweep (#2297) and its
   * drain is outstanding; that drain, and only it, records the sweep done.
   */
  private legacyNoteBodySweepQueued = false
  /**
   * Does this runner own the open bootstrap telemetry window (#1835)?
   *
   * `bootstrap-metrics` keeps the window module-global and `beginBootstrap`
   * no-ops while one is open, so a window left behind by a torn-down engine is
   * silently inherited by the NEXT vault's bootstrap — which then reports that
   * vault's `time_to_interactive` and `bootstrap_bytes_per_sec` against a dead
   * window's t0 and byte counters. Teardown must abandon what it owns.
   *
   * It must NOT abandon what it does not: `downloadRemoteVault` arms a
   * `vault_download` window BEFORE `selectVault` closes the current vault, so
   * the outgoing engine's `dispose()` runs with the incoming vault's window
   * already open.
   */
  private bootstrapWindowOwned = false
  /**
   * Does this runner hold an elevated bootstrap session (#1837)?
   *
   * Tracked separately from the window above because the two are different
   * things: the window is a telemetry CLAIM about every body being current, the
   * session is a per-user RESOURCE slot held until its TTL. Releasing the
   * session must never require making the claim.
   */
  private bootstrapSessionOpen = false
  /**
   * When did the paced drain first become blocked, with nothing since then
   * having unblocked it? Null whenever a pump actually proceeded.
   *
   * Feeds the dwell in `releaseBootstrapSessionIfBlocked` — see
   * BOOTSTRAP_DRAIN_BLOCKED_DWELL_MS for why a first blocked tick is not
   * enough to give the session up.
   */
  private drainBlockedSince: number | null = null

  constructor(
    ctx: SyncContext,
    stateManager: SyncStateManager,
    pushCoordinator: PushCoordinator,
    crdtSync: CrdtSyncCoordinator,
    actions: FullSyncActions,
    isQuarantined?: (itemId: string, itemType: string) => boolean
  ) {
    this.ctx = ctx
    this.stateManager = stateManager
    this.pushCoordinator = pushCoordinator
    this.crdtSync = crdtSync
    this.wirePullTimers()
    this.actions = actions
    this.isQuarantined = isQuarantined
  }

  /**
   * Engine start (#2297): convert a `crdtUnmergedDebt = '1'` this build did not
   * write into a debt for every note, then queue every standing debt for the
   * first full sync's drain and flag it for the snapshot routing.
   */
  loadCrdtBodyDebts(): void {
    // Never fatal to sync start (#2297 review A-1, B-L4). Each step has its
    // own `try`: a conversion that throws must not strand the rows that are
    // already standing (#2297 round 2 a-L2); the next start converts again.
    try {
      const converted = convertUnmergedDebtMirror(this.ctx.deps.db, () => this.conversionNoteIds())
      if (converted > 0) {
        log.info('Converted the vault-wide CRDT debt into per-note debts', { converted })
      }
    } catch (err) {
      log.error('Could not convert the vault-wide CRDT debt', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
    try {
      const owed = this.crdtSync.hydrateBodyDebts()
      if (owed > 0) log.info('Loaded CRDT body debts', { owed })
    } catch (err) {
      log.error('Could not load CRDT body debts', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  /** `sweepNoteIds`, or the data DB's alone when the index cache cannot be read. */
  private conversionNoteIds(): string[] {
    try {
      return this.sweepNoteIds()
    } catch (err) {
      log.error('Could not read the index cache for the CRDT debt conversion', {
        error: err instanceof Error ? err.message : String(err)
      })
      return getAllSyncableNoteMetadataIds(this.ctx.deps.db)
    }
  }

  private wirePullTimers(): void {
    this.disposed = false
    this.crdtSync.onDeferred = () => this.armDeferredPullTimer()
    this.crdtSync.onRequeued = () => this.armRequeuedPullTimer()
  }

  /**
   * Clears the deferred-pull and paced-pull timers. Call on engine teardown.
   * A chunk still in flight re-queues its notes as it aborts, and nothing may
   * arm a timer or pull for them after this (#2421), until a later `run()`.
   */
  dispose(): void {
    this.disposed = true
    this.crdtSync.onRequeued = null
    this.crdtSync.onDeferred = null
    if (this.deferredPullTimer) {
      clearTimeout(this.deferredPullTimer)
      this.deferredPullTimer = null
    }
    if (this.requeuedPullTimer) {
      clearTimeout(this.requeuedPullTimer)
      this.requeuedPullTimer = null
    }
    if (this.pacedCrdtPullTimer) {
      clearTimeout(this.pacedCrdtPullTimer)
      this.pacedCrdtPullTimer = null
    }
    // Drop the plan with the engine that made it. Leaving ids here would let a
    // chunk still in flight re-arm the pace timer from its `finally` and keep a
    // dead engine pulling against a vault it no longer owns.
    this.pacedCrdtPullQueue.clear()
    // A chunk still in flight stamps the drain it was cut out of; that is not
    // a completed legacy sweep, so the next engine runs it again.
    this.legacyNoteBodySweepQueued = false
    this.pacedCrdtPullAbort?.abort()
    this.pacedCrdtPullAbort = null
    // The telemetry window dies with the engine that armed it (#1835). Without
    // this the module-global window outlives the vault: `beginBootstrap` no-ops
    // while one is set, so the NEXT vault's bootstrap inherits this one's t0 and
    // byte counters and reports a `time_to_interactive` / `bytes_per_sec` that
    // describes neither vault.
    //
    // Only a window this runner owns. `downloadRemoteVault` arms the incoming
    // vault's `vault_download` window BEFORE `selectVault` closes the outgoing
    // one, so an unconditional abandon here would delete the window of the vault
    // being opened.
    if (this.bootstrapWindowOwned) {
      this.bootstrapWindowOwned = false
      abandonBootstrap()
    }
    // A vault switch / runtime restart revokes the elevated session (#1837):
    // local pacing reverts synchronously, the server close is best-effort and
    // must not delay teardown.
    this.bootstrapSessionOpen = false
    void closeBootstrapSession('vault_switch')
  }

  /** Signal for sweep-issued pulls, live until `dispose()` cancels them. */
  private sweepPullSignal(): AbortSignal {
    if (!this.pacedCrdtPullAbort || this.pacedCrdtPullAbort.signal.aborted) {
      this.pacedCrdtPullAbort = new AbortController()
    }
    return this.pacedCrdtPullAbort.signal
  }

  /**
   * Has a full sync on this engine finished online with a CRDT store, having
   * queued the legacy sweep if it was owed? Gates the bootstrap full-text mark:
   * before that an empty paced queue means "nothing queued yet" (an offline
   * first sync, a refused pull), not "every body is current".
   */
  private sweepSettledOnThisEngine = false

  /**
   * Has a pull actually RESOLVED on this engine? Gates the bootstrap
   * full-text mark alongside `sweepSettledOnThisEngine`: on a fresh device an
   * empty index DB makes every drain trivially empty, so only pull success is
   * evidence that any body was fetched at all.
   */
  private bootstrapPullSucceeded = false

  /**
   * Queue the one-time legacy sweep (#2297): every note owed durably, so a
   * crash mid-sweep cannot drop a note that may hold rows the feed never
   * served.
   */
  private queueLegacyNoteBodySweep(): void {
    this.crdtSync.queuePulls(this.sweepNoteIds(), 'legacy')
    this.legacyNoteBodySweepQueued = true
  }

  /**
   * The notes and journals a vault-wide sweep pulls: the index cache's order
   * first (recent first), then every syncable markdown row of the data DB the
   * cache lacks. The sweep that records `noteBodyLegacySweep = done` licenses
   * snapshot claims (#2299), so a note missing from a rebuilding index must not
   * be skipped by it.
   */
  private sweepNoteIds(): string[] {
    const ids = new Set(isIndexDatabaseInitialized() ? getAllCrdtNoteIds(getIndexDatabase()) : [])
    for (const id of getAllSyncableNoteMetadataIds(this.ctx.deps.db)) ids.add(id)
    return [...ids]
  }

  /**
   * Record the legacy sweep done once its drain has finished the vault:
   * nothing in flight, nothing queued, and nothing owed back to the pending
   * set by a chunk the server refused. An empty QUEUE is not a drained vault:
   * a rate-limited chunk hands its notes back to the pending set.
   */
  private recordLegacyNoteBodySweepDone(): void {
    if (!this.legacyNoteBodySweepQueued) return
    if (this.pacedCrdtChunkInFlight || this.pacedCrdtPullQueue.size > 0) return
    if (this.crdtSync.pendingPullCount > 0) return
    this.legacyNoteBodySweepQueued = false
    // A key reset while this drained (a server rollback) is not covered by it.
    const key = SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP
    if (this.stateManager.getStateValue(key) !== NOTE_BODY_LEGACY_SWEEP_PENDING) return
    this.stateManager.setStateValue(key, NOTE_BODY_LEGACY_SWEEP_DONE)
    log.info('fullSync: note-body legacy sweep complete')
  }

  /**
   * The change feed deleted the legacy key (#2297): the server stopped serving
   * bodies. The sweep already queued cannot cover the rows written from then
   * on, so its drain records nothing, and the next negotiated page re-arms it.
   */
  resetNoteBodyLegacySweep(): void {
    this.legacyNoteBodySweepQueued = false
  }

  async run(): Promise<void> {
    log.debug('fullSync started')
    if (this.disposed) this.wirePullTimers()
    // No persisted cursor = this device has never completed a pull for this
    // vault: a genuine fresh-device bootstrap (#1835). beginBootstrap no-ops
    // while a window is already open (the vault-download seam fires earlier
    // and keeps the truer start time), and telemetry must never break sync.
    const isFreshDevice = this.stateManager.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR) == null
    try {
      if (isFreshDevice) {
        beginBootstrap('first_full_sync')
        // Owned from here whether or not `beginBootstrap` armed it: a window
        // the vault-download seam opened for THIS vault is one this runner is
        // now responsible for closing or abandoning.
        this.bootstrapWindowOwned = true
        // Elevated limits + presigned sets for this pull (#1837). Any failure
        // — old server, unconfigured, capped, offline — silently falls back to
        // steady-state pacing; nothing downstream may depend on it succeeding.
        await openBootstrapSession(this.ctx.deps.getAccessToken)
        this.bootstrapSessionOpen = true
      }
    } catch {
      /* telemetry only — sync proceeds */
    }
    this.ctx.fullSyncActive = true
    let packSeededNoteIds: string[] = []
    if (isFreshDevice) {
      // Compaction packs (#1840): seed note bodies from a handful of large
      // transfers before the item-granular pull, so the CRDT sweep that
      // follows finds them already merged and issues no snapshot GETs for
      // them. Every failure mode inside — old server, no presign secrets, zero
      // packs, a bad pack — returns quietly, and the pull below then runs
      // byte-for-byte as it does on a deployment with no packs at all. It is
      // awaited rather than fired off because it writes into the same Y.Docs
      // and the same DBs the pull is about to touch.
      packSeededNoteIds = await this.applyBootstrapPacks()
    }
    // A pull that delivered ran to the head of the feed unrefused (#1835): only
    // then can a vault sweep cover every note whose record exists (#2297).
    let pullDelivered = false
    try {
      // Evidence for the full-text mark: the pull REPORTED that it delivered.
      // "The await did not reject" is true on every production run — the engine
      // swallows every error and the coordinator returns early on a busy lock,
      // missing credentials or a page it refused to apply — so it proved
      // nothing outside a unit test whose `pull` was a bare mock.
      const repairFrom = await this.beginCursorSkipRepair()
      const changedBeforePull = this.ctx.applier.changedCount
      pullDelivered = await this.actions.pull()
      if (pullDelivered) {
        this.bootstrapPullSucceeded = true
        if (repairFrom !== null) {
          this.finishCursorSkipRepair(repairFrom, this.ctx.applier.changedCount - changedBeforePull)
        }
      }
      log.debug('fullSync: pull complete')
      await this.settlePackSeededDocs(packSeededNoteIds)

      const queueBeforeSeed = this.ctx.deps.queue.getPendingCount()
      const signingKeys = await this.ctx.deps.getSigningKeys()
      if (signingKeys) {
        // Seed from the complete handler registry (runInitialSeed's default),
        // never from the runtime adapter registry. Every other consumer reads
        // that registry as `getRemote(type) ?? getRemoteSyncAdapter(type)`, but
        // `getAllRemote()` has no such fallback: a type missing from the runtime
        // list silently never seeds, stranding its clock-less rows on this
        // device forever. tag_category shipped that way.
        runInitialSeed({
          db: this.ctx.deps.db,
          queue: this.ctx.deps.queue,
          deviceId: signingKeys.deviceId
        })
      }
      const seededCount = Math.max(0, this.ctx.deps.queue.getPendingCount() - queueBeforeSeed)
      log.debug('fullSync: seed complete', {
        attempted: signingKeys ? 'yes' : 'skipped',
        seededCount
      })

      const queueAfterSeed = this.ctx.deps.queue.getPendingCount()
      if (queueAfterSeed > 0) {
        this.ctx.deps.emitToRenderer(EVENT_CHANNELS.INITIAL_SYNC_PROGRESS, {
          phase: 'tasks',
          processedItems: 0,
          totalItems: queueAfterSeed
        } satisfies InitialSyncProgressEvent)
      }

      await this.actions.push()
      log.debug('fullSync: push complete')

      this.ctx.deps.emitToRenderer(EVENT_CHANNELS.INITIAL_SYNC_PROGRESS, {
        phase: 'manifest',
        processedItems: 0,
        totalItems: 0
      } satisfies InitialSyncProgressEvent)

      const persistedRaw = Number(
        this.stateManager.getStateValue(SYNC_STATE_KEYS.LAST_MANIFEST_CHECK_AT) ?? '0'
      )
      // Clamp to now: a future-dated persisted timestamp (clock skew, machine
      // migration) would otherwise throttle the check until the wall clock
      // catches up with it.
      const persistedCheckAt = Number.isFinite(persistedRaw)
        ? Math.min(persistedRaw, Date.now())
        : 0
      const manifestResult = await checkManifestIntegrity({
        db: this.ctx.deps.db,
        queue: this.ctx.deps.queue,
        getAccessToken: this.ctx.deps.getAccessToken,
        isOnline: () => this.ctx.deps.network.online,
        lastCheckAt: Math.max(this.lastManifestCheckAt, persistedCheckAt),
        isQuarantined: this.isQuarantined,
        // #2302: no local re-upload unless this run's pull delivered first.
        reuploadLocalOnly: pullDelivered
      })
      this.lastManifestCheckAt = manifestResult.checkedAt
      // Persist only when a manifest was actually fetched and diffed: stamping
      // the no-token or fetch-failure paths would silently defer the next REAL
      // check by the full 30-minute window.
      if (manifestResult.performed) {
        this.stateManager.setStateValue(
          SYNC_STATE_KEYS.LAST_MANIFEST_CHECK_AT,
          String(manifestResult.checkedAt)
        )
      }
      if (manifestResult.performed) {
        log.debug('fullSync: manifest check complete', {
          rePullNeeded: manifestResult.rePullNeeded,
          serverOnlyCount: manifestResult.serverOnlyCount
        })
      } else {
        // Never log serverOnlyCount here: its 0 reads as "verified clean" when
        // no manifest was fetched (#2310).
        const { skipped } = manifestResult
        log.debug('fullSync: manifest check skipped', {
          reason: skipped?.reason,
          nextEligibleAt: skipped ? new Date(skipped.nextEligibleAt).toISOString() : undefined
        })
      }

      // The re-pull runs from cursor 0, so every note and journal record it
      // applies pulls its whole body (#2421).
      if (manifestResult.rePullNeeded) {
        log.info('fullSync: manifest detected server-only items, resetting cursor for re-pull', {
          serverOnlyCount: manifestResult.serverOnlyCount
        })
        this.stateManager.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
        // Same evidence rule: the re-pull can deliver where the first one was
        // refused, and that is a delivery like any other.
        pullDelivered = await this.actions.pull()
        if (pullDelivered) this.bootstrapPullSucceeded = true
      }

      this.pushCoordinator.clearPendingAfterFullSync()

      const pendingAfterManifest = this.ctx.deps.queue.getPendingCount()
      if (pendingAfterManifest > 0 && !this.stateManager.isPaused()) {
        log.debug('fullSync: follow-up push', { pendingAfterManifest })
        await this.actions.push()
      }

      this.ctx.deps.queue.purgeOldErrors(
        new Date(Date.now() - ERROR_RETENTION_DAYS * 24 * 60 * 60 * 1000)
      )

      this.ctx.deps.emitToRenderer(EVENT_CHANNELS.INITIAL_SYNC_PROGRESS, {
        phase: 'complete',
        processedItems: 0,
        totalItems: 0
      } satisfies InitialSyncProgressEvent)
    } catch (error) {
      // A first attempt that never completed a pull measured nothing
      // legitimate: abandon the window so it cannot sit open across retries
      // counting steady-state bytes against a stale t0. Once a pull HAS
      // resolved the window stays — its bytes are real, and the mark fires
      // once the sweep drains. The cursor is only persisted after a successful
      // pull, so the next cycle re-arms a clean window here.
      if (!this.bootstrapPullSucceeded) {
        this.bootstrapWindowOwned = false
        abandonBootstrap()
      }
      // Same for the elevated session: a failed run releases it immediately,
      // so pacing reverts before the next cycle starts (#1837).
      this.bootstrapSessionOpen = false
      await closeBootstrapSession('failed')
      throw error
    } finally {
      this.ctx.fullSyncActive = false
      // Without a CRDT provider or an initialized index DB nothing is ever
      // queued, and offline nothing is fetchable, so an empty paced queue is
      // not evidence that bodies are current: that case stays unsettled, and
      // the bootstrap mark waits for a later cycle.
      if (this.ctx.deps.crdtProvider != null && isIndexDatabaseInitialized()) {
        if (this.ctx.deps.network.online) {
          // Forced until one drains: the change feed never serves the body
          // rows this sweep exists for (#2297 review).
          if (
            pullDelivered &&
            !this.legacyNoteBodySweepQueued &&
            this.stateManager.getStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP) ===
              NOTE_BODY_LEGACY_SWEEP_PENDING
          ) {
            this.queueLegacyNoteBodySweep()
          }
          this.sweepSettledOnThisEngine = true
        }
      }
      // flushPendingCrdtPulls() ends with pumpPacedCrdtPulls() +
      // maybeMarkBootstrapFullText(), so the settle above is re-evaluated here
      // without a second call of our own.
      this.flushPendingCrdtPulls()
    }
  }

  /**
   * Starts or resumes the one-time re-pull (#2382); see
   * `SYNC_STATE_KEYS.CURSOR_SKIP_REPAIR`. Returns the cursor the repair reset
   * from while it is pending, else null.
   *
   * The reset happens under the sync lock: a pull holding the lock would
   * otherwise overwrite the reset with its own next cursor, and the repair
   * would be recorded without ever re-reading the skipped range.
   */
  private async beginCursorSkipRepair(): Promise<number | null> {
    const recorded = this.stateManager.getStateValue(SYNC_STATE_KEYS.CURSOR_SKIP_REPAIR)
    if (recorded === CURSOR_SKIP_REPAIR_DONE) return null
    const pendingFrom = Number(recorded?.match(/^pending:(\d+)$/)?.[1])
    if (Number.isInteger(pendingFrom)) return pendingFrom

    const release = await this.ctx.acquireLock()
    if (!release) return null
    try {
      const cursor = Number(this.stateManager.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR) ?? '0')
      if (!Number.isInteger(cursor) || cursor <= 0) {
        this.stateManager.setStateValue(SYNC_STATE_KEYS.CURSOR_SKIP_REPAIR, CURSOR_SKIP_REPAIR_DONE)
        return null
      }
      log.info('fullSync: cursor-skip repair, re-pulling from cursor 0', { fromCursor: cursor })
      // Cursor first: a crash between the two writes leaves cursor 0 and no
      // key, which the next run records as done with nothing lost.
      this.stateManager.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
      this.stateManager.setStateValue(SYNC_STATE_KEYS.CURSOR_SKIP_REPAIR, `pending:${cursor}`)
      return cursor
    } finally {
      this.ctx.releaseLock()
      release()
    }
  }

  private finishCursorSkipRepair(fromCursor: number, changedItems: number): void {
    this.stateManager.setStateValue(SYNC_STATE_KEYS.CURSOR_SKIP_REPAIR, CURSOR_SKIP_REPAIR_DONE)
    log.info('fullSync: cursor-skip repair complete', { fromCursor, changedItems })
    trackMainEvent('sync_run_completed', {
      surface: 'sync',
      action: 'cursor_skip_repair',
      result: 'success',
      metrics: { itemCount: changedItems, value: fromCursor },
      source: 'full',
      dimensions: { transport: 'record' }
    })
  }

  /**
   * Fresh-device pack bootstrap (#1840).
   *
   * NEVER THROWS. Packs are a derived cache; the item-granular endpoints stay
   * the source of truth, so an old server, a deployment without presign
   * secrets, a vault with no packs yet, a corrupt pack or a dead transfer all
   * end here quietly and the pull that follows behaves exactly as it does on a
   * deployment where packs do not exist. The sync cursor is untouched either
   * way — nothing in this path writes `LAST_CURSOR`.
   */
  private async applyBootstrapPacks(): Promise<string[]> {
    const seeded: string[] = []
    try {
      const provider = this.ctx.deps.crdtProvider
      // No CRDT store means no document to seed and no watermark to record;
      // an in-memory provider rebuilds bodies from vault markdown instead.
      //
      // This used to `return` silently, which made a skipped pack bootstrap
      // indistinguishable from one that ran and found no packs: a real
      // fresh-device run produced ZERO pack log lines and never even created
      // the temp dir, and nothing in the logs said why. A feature that can
      // no-op itself has to say so.
      if (!provider?.storeId) {
        log.info('fullSync: pack bootstrap skipped — no CRDT store', {
          hasProvider: provider != null,
          storeId: provider?.storeId ?? null
        })
        return seeded
      }

      const [
        path,
        { app },
        { runPackBootstrap },
        { createCrdtSnapshotApplier, decodeSignerPublicKeys },
        { beginPageApply },
        { DownloadPacer },
        { syncDevices },
        { fetchAndCacheDeviceKeys }
      ] = await Promise.all([
        import('node:path'),
        import('electron'),
        import('../packs/pack-bootstrap'),
        import('../packs/crdt-snapshot-applier'),
        import('../bulk-apply'),
        import('../download-queue'),
        import('@memry/db-schema/schema/sync-devices'),
        import('../device-keys')
      ])

      // The attachment transfer pacer, not a second one: same fixed window,
      // same elevation seam. Read once here because a bootstrap session that
      // closes mid-run only ever narrows back toward the conservative base.
      const pacer = new DownloadPacer(PACK_DOWNLOAD_MAX_REQUESTS_PER_MINUTE)
      pacer.setMultiplier(getBootstrapElevationFactor())

      const applier = createCrdtSnapshotApplier({
        store: {
          getSnapshotWatermark: (noteId) => provider.getSnapshotWatermark(noteId),
          putSnapshotWatermark: (noteId, watermark) =>
            provider.putSnapshotWatermark(noteId, watermark),
          // `skipSeed`, exactly as the CRDT sweep opens a doc it is about to
          // apply server state into: seeding from local markdown first would
          // give the doc a fresh client id and a history the packed baseline
          // never saw. Without an open doc the provider drops the update.
          openDoc: async (noteId) => {
            await provider.open(noteId, undefined, { skipSeed: true })
          },
          applyRemoteUpdate: (noteId, update) => provider.applyRemoteUpdate(noteId, update),
          getStateVector: (noteId) => provider.getStateVector(noteId),
          closeDoc: async (noteId) => {
            await provider.closeIfInactive(noteId)
          }
        },
        getVaultKey: this.ctx.deps.getVaultKey,
        getSignerPublicKeys: async () => {
          // `sync_devices` holds ONLY this device's own row on a fresh
          // install — peer rows arrive through `fetchAndCacheDeviceKeys`,
          // whose single caller is the item-granular CRDT pull that runs
          // AFTER this. Every packed snapshot was signed by some other
          // device, so without this refresh not one packed blob verifies and
          // the whole feature is a no-op on exactly the devices it exists
          // for. Resolved lazily by the applier — once per bootstrap, and
          // only once an entry is actually up for apply — so a vault with no
          // usable packs pays nothing, and a failed refresh just leaves the
          // cache as the candidate list.
          const token = await this.ctx.deps.getAccessToken().catch(() => null)
          if (token) {
            try {
              await fetchAndCacheDeviceKeys(this.ctx.deps.db, token)
            } catch (error) {
              log.debug('Could not refresh device signing keys for pack bootstrap', {
                error: error instanceof Error ? error.message : String(error)
              })
            }
          }
          return decodeSignerPublicKeys(
            this.ctx.deps.db
              .select({ key: syncDevices.signingPublicKey })
              .from(syncDevices)
              .all()
              .map((row) => row.key)
          )
        }
      })

      const result = await runPackBootstrap({
        getAccessToken: this.ctx.deps.getAccessToken,
        tempDir: path.join(app.getPath('userData'), 'sync-packs'),
        snapshots: {
          shouldApply: (noteId, meta) => applier.shouldApply(noteId, meta),
          apply: async (noteId, bytes, meta) => {
            const applied = await applier.apply(noteId, bytes, meta)
            if (applied) seeded.push(noteId)
            return applied
          }
        },
        beginPage: () => beginPageApply(this.ctx.deps.db),
        getStateValue: (key) => this.stateManager.getStateValue(key),
        setStateValue: (key, value) => this.stateManager.setStateValue(key, value),
        emit: (channel, data) => this.ctx.deps.emitToRenderer(channel, data),
        ...(this.ctx.abortController ? { signal: this.ctx.abortController.signal } : {}),
        pace: () => pacer.acquire()
      })

      if (result.usedPacks) {
        log.info('fullSync: bootstrap packs applied', {
          packsApplied: result.packsApplied,
          entriesApplied: result.entriesApplied,
          entriesSkipped: result.entriesSkipped,
          entriesFailed: result.entriesFailed,
          appliedThroughCursor: result.appliedThroughCursor
        })
      }
    } catch (error) {
      log.info('fullSync: pack bootstrap unavailable — item-granular bootstrap', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
    return seeded
  }

  /**
   * Packed bodies land before any record exists, so the write-back each of
   * them armed found no row and wrote nothing. After the pull, a note it
   * created gets its body from the doc. A doc whose id still has no row is
   * dropped: the pull tombstoned it, or it never had a record. A record that
   * arrives later has no watermark left to settle against, so its body debt
   * walks the whole body again.
   */
  private async settlePackSeededDocs(noteIds: readonly string[]): Promise<void> {
    const provider = this.ctx.deps.crdtProvider
    if (!provider || noteIds.length === 0) return
    let materialized = 0
    let purged = 0
    for (const noteId of noteIds) {
      try {
        if (isKnownNote(this.ctx.deps.db, noteId)) {
          await provider.materialize(noteId)
          materialized++
        } else {
          await provider.purge(noteId)
          purged++
        }
      } catch (error) {
        log.warn('fullSync: could not settle a pack-seeded doc', {
          noteId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    log.info('fullSync: pack-seeded docs settled', { materialized, purged })
  }

  /**
   * Pays the queued pulls: the durable body debts (a record, a feed entry, a
   * `crdt_updated` broadcast before the legacy sweep is done), the legacy
   * sweep and whatever a failed chunk owes. Runs at the end of every full sync
   * and after every pull outside one (#2421).
   *
   * Everything leaves through the batch path rather than one
   * `pullCrdtForNote` per note. The single-note path costs two GETs per note, so
   * a 121-note sweep fired 242 requests in about four seconds against the
   * server's `crdt_pull` bucket — then 300 per 60s and shared across the
   * account's devices — and 92 of those 121 notes came back "Too many requests"
   * and, before the re-queue above, kept a stale body until the next sweep.
   * #1466 has since raised that bucket to 600 per 60s and keyed it per device,
   * so that exact burst would fit today; the pacing stays because a vault twice
   * the size still would not.
   *
   * Batching alone does not fix that; it only halves it, because the batch
   * endpoint batches the incrementals and not the per-note snapshot baselines.
   * The pacing below is what keeps a sweep inside both of the server's buckets.
   * See CRDT_SWEEP_CHUNK_NOTES for the arithmetic on each.
   */
  flushPendingCrdtPulls(): void {
    if (this.disposed) return
    if (this.crdtSync.pendingPullCount > 0) {
      log.debug('fullSync: flushing pending CRDT pulls', {
        count: this.crdtSync.pendingPullCount
      })

      // A note with a live editor is the one the user is looking at, and a stale
      // body there is the whole bug. It must not queue behind a catch-up that
      // takes minutes on a large vault, so it skips the pace entirely. The cost
      // is bounded by the number of open editors — a handful — which is what the
      // headroom described on CRDT_SWEEP_CHUNK_NOTES is for.
      const activeNoteIds = new Set(
        this.ctx.deps.crdtProvider?.getOpenNoteIds({ active: true }) ?? []
      )
      // Tier 2: docs the provider still holds without a window attached. The
      // 32-doc LRU IS a recently-opened list, already in memory and free to
      // read, and those are the notes the user is one click from — so they lead
      // the paced queue instead of taking whatever position the vault-wide
      // ordering gave them.
      const openNoteIds = new Set(this.ctx.deps.crdtProvider?.getOpenNoteIds() ?? [])

      const priority: string[] = []
      const openInactive: string[] = []
      const rest: string[] = []
      for (const noteId of this.crdtSync.drainPendingPulls()) {
        if (activeNoteIds.has(noteId)) priority.push(noteId)
        else if (openNoteIds.has(noteId)) openInactive.push(noteId)
        else rest.push(noteId)
      }

      // Rebuilt rather than appended to, because a sweep that lands mid-drain
      // would otherwise put the open docs behind however many thousand notes
      // the previous pass has left waiting. Re-inserting the old ids after them
      // keeps the queue deduped and keeps the tail in its established order.
      // This is a reordering and nothing else: every drained id still enters the
      // queue, because priority must never become filtering — a note skipped
      // here is a body-only remote edit this device never learns about.
      if (openInactive.length > 0) {
        this.pacedCrdtPullQueue = new Set([...openInactive, ...this.pacedCrdtPullQueue])
      }
      for (const noteId of rest) this.pacedCrdtPullQueue.add(noteId)

      if (priority.length > 0) {
        const scheduled = this.actions.scheduleSync(async () => {
          // Its cost is deliberately discarded: this batch jumps the pace by
          // design — the note the user is looking at must not wait behind a
          // catch-up — and it is bounded by the number of open editors, which
          // is what the other half of each bucket's margin is reserved for.
          await this.crdtSync.pullCrdtForNotes(priority, this.sweepPullSignal())
        })
        // Dropped by a running full sync: back to the pending set, which that
        // sync's closing flush drains (#2421).
        if (!scheduled) this.crdtSync.returnPendingPulls(priority)
      }
    }

    this.armDeferredPullTimer()
    this.pumpPacedCrdtPulls()
    this.maybeMarkBootstrapFullText()
    this.recordLegacyNoteBodySweepDone()
    this.releaseBootstrapSessionIfStalled()
  }

  /**
   * A floor for pulls re-queued after a failure that counted nothing (a rate
   * limit, an abort): one timer, CRDT_REQUEUED_PULL_FLOOR_MS after the first
   * re-queue, flushes them when no other trigger did (#2421). A full sync or
   * a paused engine skips it; the sync's own flush and resume drain them.
   */
  private armRequeuedPullTimer(): void {
    if (this.requeuedPullTimer || this.disposed) return
    this.requeuedPullTimer = setTimeout(() => {
      this.requeuedPullTimer = null
      if (this.ctx.fullSyncActive || this.stateManager.isPaused()) return
      this.flushPendingCrdtPulls()
    }, CRDT_REQUEUED_PULL_FLOOR_MS)
    this.requeuedPullTimer.unref?.()
  }

  /**
   * One timer for the earliest deferred pull's backoff end (#2297 review A-2):
   * nothing else drains between full syncs, so without it a failing note's
   * retry waits for the next reconnect, restart or manual sync. Armed from
   * each flush and from each counted failure (`onDeferred`).
   *
   * The delay is capped at the longest backoff: past setTimeout's 2^31 ms
   * limit a delay fires after 1 ms, and a clock set back leaves a due time
   * far ahead (#2297 round 2 a-M2).
   */
  private armDeferredPullTimer(): void {
    const next = this.crdtSync.nextDeferredPullAt()
    if (next === null) return
    const now = Date.now()
    const at = Math.min(next, now + CRDT_BODY_DEBT_MAX_BACKOFF_MS)
    if (this.deferredPullTimer) {
      if (this.deferredPullTimerAt <= at) return
      clearTimeout(this.deferredPullTimer)
    }
    this.deferredPullTimerAt = at
    this.deferredPullTimer = setTimeout(
      () => {
        this.deferredPullTimer = null
        this.crdtSync.requeueDeferredPulls()
        // A full sync's `finally` flush drains these and re-arms; a flush
        // from here would drain its active-editor notes into a
        // `scheduleSync` the engine drops while it runs (#2297 round 2 b-L2).
        if (this.ctx.fullSyncActive) return
        this.flushPendingCrdtPulls()
      },
      Math.max(0, at - now)
    )
    this.deferredPullTimer.unref?.()
  }

  /**
   * Bootstrap seam (#1835): the paced queue draining to empty — after a full
   * sync settled it and with nothing owed back to the pending set — is the moment
   * every note body the server holds is current on this device. The metrics
   * module makes this a no-op outside an active fresh-device bootstrap, so
   * steady-state cycles pay one boolean check.
   *
   * The elevated session (#1837) closes at the same moment: full-text is the
   * definition of "bootstrap done", and closing releases the per-user session
   * slot while reverting every pacing site in the same tick.
   */
  private maybeMarkBootstrapFullText(): void {
    if (!this.sweepSettledOnThisEngine) return
    // On a fresh device an empty index DB makes every drain trivially empty,
    // failed pull or not. Only a pull that actually resolved turns "queue
    // empty" into "bodies delivered".
    if (!this.bootstrapPullSucceeded) return
    if (this.pacedCrdtChunkInFlight || this.pacedCrdtPullQueue.size > 0) return
    if (this.crdtSync.pendingPullCount > 0) return
    this.bootstrapWindowOwned = false
    markBootstrapFullText()
    this.releaseBootstrapSession('completed')
  }

  /**
   * Release the elevated session (#1837).
   *
   * Separate from the full-text mark on purpose. Releasing is a RESOURCE
   * concern — the per-user session slot is held until its TTL, up to 60
   * minutes — while marking full text is a CLAIM that every body on the server
   * is current on this device. Reaching release only through the mark meant
   * every path where the claim is legitimately impossible leaked the slot: an
   * uninitialized index DB, notes a rate-limited chunk owed back to the pending
   * set (which is what a large bootstrap produces), a drain that went offline
   * and stayed there.
   */
  private releaseBootstrapSession(reason: 'completed' | 'idle'): void {
    if (!this.bootstrapSessionOpen) return
    this.bootstrapSessionOpen = false
    void closeBootstrapSession(reason)
  }

  /**
   * Release the session once the paced drain has stopped moving.
   *
   * The session legitimately spans the whole drain — the elevation factor is
   * what paces it — so a chunk in flight or a queue with work left in it is not
   * a stall and must not be cut short. What IS a stall: an empty queue with
   * nothing in flight, whether the drain finished cleanly (the mark above has
   * already released it by then) or ended owing its notes back to the pending
   * set, where nothing on this engine will pick them up until the next cycle.
   */
  private releaseBootstrapSessionIfStalled(): void {
    if (this.pacedCrdtChunkInFlight || this.pacedCrdtPullQueue.size > 0) return
    this.releaseBootstrapSession('idle')
  }

  /**
   * Release the session once the drain has been blocked for long enough that
   * the block is no longer plausibly transient.
   *
   * `terminal` skips the dwell for a block that cannot lift on its own:
   * `ctx.deps.crdtProvider` is fixed for the life of the engine, so without one
   * there is never a document to merge into and waiting buys nothing. A network
   * block is the opposite — it lifts by itself constantly — and is what the
   * dwell exists for.
   */
  private releaseBootstrapSessionIfBlocked(terminal: boolean): void {
    if (terminal) {
      this.drainBlockedSince = null
      this.releaseBootstrapSession('idle')
      return
    }
    this.drainBlockedSince ??= Date.now()
    if (Date.now() - this.drainBlockedSince < BOOTSTRAP_DRAIN_BLOCKED_DWELL_MS) return
    this.releaseBootstrapSession('idle')
  }

  /**
   * Start or continue the paced drain of the CRDT catch-up queue.
   *
   * At most one chunk is in flight and at most one timer is armed at any moment.
   * Both matter: a second fullSync landing mid-drain that started its own pass,
   * or a flapping socket arming a timer per reconnect, would multiply the
   * request rate by however many drains were running and put the arithmetic on
   * CRDT_SWEEP_CHUNK_NOTES straight back over the server's limit — which is the
   * storm this pacing exists to remove, not a new one to introduce.
   */
  private pumpPacedCrdtPulls(): void {
    if (this.pacedCrdtPullTimer || this.pacedCrdtChunkInFlight || this.disposed) return
    if (this.pacedCrdtPullQueue.size === 0) return

    const crdtProvider = this.ctx.deps.crdtProvider
    // `scheduleSync` silently
    // drops its callback while a fullSync is active, and pulls issued offline
    // are guaranteed to fail. Keep the queue intact and look again next tick
    // rather than spending a chunk on a request that cannot land.
    if (this.ctx.fullSyncActive || !this.ctx.deps.network.online || !crdtProvider) {
      this.armPacedCrdtPullTimer()
      // A drain that cannot run is not being paced by the elevated session, so
      // a block that STAYS blocked held the slot until its TTL for a drain
      // spending nothing (#1837). But the release is one-way — the session is
      // opened once per vault and nothing re-opens it — so it waits out a dwell
      // rather than firing on the first blocked tick; see
      // BOOTSTRAP_DRAIN_BLOCKED_DWELL_MS. `fullSyncActive` is exempt entirely:
      // it lasts one cycle, whose own `finally` re-pumps, so it is a wait
      // rather than a stall and must not even start the dwell. Elevation is
      // re-read per chunk, so a drain that resumes without a session simply
      // reverts to conservative pacing.
      if (!this.ctx.fullSyncActive) this.releaseBootstrapSessionIfBlocked(!crdtProvider)
      return
    }

    // The drain is moving again: whatever blocked it did not persist, so a
    // later block starts its dwell from scratch instead of inheriting this one.
    this.drainBlockedSince = null

    // The PROBE's size, not the apply phase's. One `POST /sync/crdt/updates/batch`
    // covers the whole chunk without opening a document, so the doc cache does
    // not bound it — `applyCrdtBatch` sub-chunks the apply phase at
    // `inactiveDocCapacity` itself, which is where that bound belongs. Clamping
    // here to the doc cache instead would spend one probe POST per 32 notes,
    // and the probe POST is the entire cost of a warm sweep.
    const chunkSize = Math.max(1, CRDT_SWEEP_CHUNK_NOTES)
    const chunk: string[] = []
    for (const noteId of this.pacedCrdtPullQueue) {
      if (chunk.length >= chunkSize) break
      chunk.push(noteId)
    }
    for (const noteId of chunk) this.pacedCrdtPullQueue.delete(noteId)

    log.debug('fullSync: paced CRDT pull chunk', {
      chunk: chunk.length,
      remaining: this.pacedCrdtPullQueue.size
    })

    this.pacedCrdtChunkInFlight = true
    this.actions.scheduleSync(async () => {
      // The floor covers the throw: a chunk that failed part-way still spent
      // whatever it spent, and the count is lost with the rejection. Waiting the
      // minimum is the conservative reading, and every note in it is owed to the
      // next cycle anyway.
      let delayMs = CRDT_SWEEP_CHUNK_INTERVAL_MS
      try {
        // The interval is CHARGED, not fixed. A warm chunk of 100 costs one
        // probe POST and waits 4 s; the same 100 notes cold cost 100 snapshot
        // GETs and four apply rounds and wait 20 s. One constant cannot be
        // right for both, and the client cannot know which it is in until the
        // chunk has run — that is what the probe is for. See
        // `crdtSweepChunkDelayMs` for the full derivation. The charge is
        // divided by the bootstrap elevation factor when a session is live
        // (#1837); reading it here (not caching it) means the very first chunk
        // after close/expiry reverts to conservative pacing.
        delayMs = crdtSweepChunkDelayMs(
          await this.crdtSync.pullCrdtForNotes(chunk, this.sweepPullSignal()),
          getBootstrapElevationFactor()
        )
      } finally {
        // Re-arm from the chunk's completion, not from when it was issued, so a
        // slow chunk stretches the interval instead of overlapping the next one.
        // Notes this chunk failed are back in the pending set by now, not in the
        // queue: they are owed to the next cycle, deliberately, because retrying
        // them here would just re-run into whatever refused them.
        this.pacedCrdtChunkInFlight = false
        this.armPacedCrdtPullTimer(delayMs)
        this.maybeMarkBootstrapFullText()
        this.recordLegacyNoteBodySweepDone()
        this.releaseBootstrapSessionIfStalled()
      }
    })
  }

  /**
   * `delayMs` defaults to the floor, which is what the blocked-drain path wants:
   * offline, or a fullSync holding `scheduleSync`, spent no request budget, so
   * it only needs to look again soon.
   */
  private armPacedCrdtPullTimer(delayMs: number = CRDT_SWEEP_CHUNK_INTERVAL_MS): void {
    if (this.pacedCrdtPullTimer || this.pacedCrdtPullQueue.size === 0) return

    this.pacedCrdtPullTimer = setTimeout(() => {
      this.pacedCrdtPullTimer = null
      this.pumpPacedCrdtPulls()
    }, delayMs)
    this.pacedCrdtPullTimer.unref?.()
  }
}
