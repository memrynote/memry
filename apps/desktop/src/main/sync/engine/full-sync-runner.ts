import { createLogger } from '../../lib/logger'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import type { InitialSyncProgressEvent } from '@memry/contracts/ipc-events'
import { ERROR_RETENTION_DAYS } from '@memry/sync-client/queue'
import { abandonBootstrap, beginBootstrap, markBootstrapFullText } from '../bootstrap-metrics'
import { closeBootstrapSession, openBootstrapSession } from '../bootstrap-session'
import { getBootstrapElevationFactor } from '../bootstrap-session-state'
import { checkManifestIntegrity } from '../manifest-check'
import { runInitialSeed } from '../initial-seed'
import type { SyncContext } from './sync-context'
import {
  CRDT_FULL_SWEEP_MIN_INTERVAL_MS,
  CRDT_RECONNECT_SWEEP_FLOOR_MS,
  CRDT_SWEEP_CHUNK_INTERVAL_MS,
  CRDT_SWEEP_CHUNK_NOTES,
  crdtSweepChunkDelayMs,
  SYNC_STATE_KEYS
} from './sync-context'
import type { SyncStateManager } from './sync-state-manager'
import type { PushCoordinator } from './push-coordinator'
import type { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import { getAllCrdtNoteIds } from '../../database/queries/notes'
import { getIndexDatabase, isIndexDatabaseInitialized } from '../../database/client'

const log = createLogger('SyncEngine')

export interface FullSyncActions {
  pull: () => Promise<void>
  push: () => Promise<void>
  scheduleSync: (fn: () => Promise<void>) => void
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
   * WebSocket connection generation observed the last time this runner swept.
   * Null until it sweeps once — deliberately in-memory only: a generation from
   * a previous process says nothing about the current socket.
   */
  private lastSweepConnectionGeneration: number | null = null
  /**
   * When this runner last swept *because the socket had dropped and come back*.
   * Null until that happens. The reconnect floor is measured against this and
   * not against `LAST_CRDT_SWEEP_AT`, because that stamp also covers startup,
   * forced and interval sweeps — none of which say anything about how often
   * reconnects are arriving. Measuring the floor against them made the first
   * reconnect after any recent sweep (a plain app start, then one Wi-Fi blip)
   * wait out the whole floor before the vault was swept, which is exactly the
   * case the floor was never meant to cover.
   *
   * In-memory only, like `lastSweepConnectionGeneration`: a reconnect from a
   * previous process says nothing about this socket's flap rate.
   */
  private lastReconnectSweepAt: number | null = null
  /**
   * A reconnect gap was seen inside the floor and the deferred timer has not
   * paid it yet. Cleared by any sweep, so a fullSync that arrives past the
   * floor first settles the debt and the pending timer becomes a no-op instead
   * of sweeping the vault a second time.
   */
  private crdtSweepOwed = false
  private owedSweepTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Notes drained from the pending-pull set that are waiting their turn in a
   * paced catch-up chunk.
   *
   * A Set, so a note re-queued by a failed chunk cannot accumulate duplicates
   * across cycles — the queue stays bounded by the vault, not by how many times
   * the server has said no. Insertion order is preserved, so it still drains
   * FIFO — which makes insertion order the catch-up's priority: open-but-
   * inactive docs are spliced in at the front by `flushPendingCrdtPulls`, and
   * `getAllCrdtNoteIds` supplies the rest of the vault in `modifiedAt DESC`.
   * In-memory by design: this queue is a plan for the current engine's
   * catch-up, and the persisted sweep stamp is what carries the work across a
   * restart.
   */
  private pacedCrdtPullQueue = new Set<string>()
  private pacedCrdtPullTimer: ReturnType<typeof setTimeout> | null = null
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
   * Did the *previous* session end holding notes whose server state it had not
   * merged? Null until the persisted answer is read.
   *
   * Read lazily rather than in the constructor: this runner is built inside the
   * SyncEngine constructor, and a `sync_state` lookup belongs to the first cycle
   * that needs it rather than to construction.
   */
  private carriedUnmergedDebt: boolean | null = null

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
    this.actions = actions
    this.isQuarantined = isQuarantined
  }

  /**
   * Should the end-of-cycle sweep re-queue every CRDT note in the vault?
   *
   * The sweep is the only way a body-only remote edit is discovered when this
   * device was not connected to receive its `crdt_updated` broadcast — note
   * bodies never travel in the record change feed (NoteSync sends
   * `content: null` on update), so nothing else covers them. It therefore stays
   * exhaustive: no note is ever excluded from a sweep that runs.
   *
   * What changes is WHEN it runs, and that is decided by the trigger rather
   * than by a clock, because fullSync's callers are not equivalent. Fired by
   * auth refresh or rate-limit release on a socket that never dropped, a sweep
   * is provably pointless — every broadcast in that window arrived. Fired by a
   * real reconnect, it is provably necessary, and is exactly when the user is
   * most likely looking at a stale note, so it must not wait out the interval.
   * Only when the trigger is unknowable does the interval decide.
   */
  /**
   * Can this session still not name the notes whose server state it has not
   * merged?
   *
   * `CrdtSyncCoordinator.unmergedRemoteNotes` is per session and `clearCaches()`
   * empties it at teardown, so an unmerged note came back on the next launch
   * looking merged — and "merged" is the answer that routes its push to the
   * endpoint that prunes every peer row at or below the new snapshot's
   * watermark. Nor did the launch necessarily re-raise the flag on its own:
   * `shouldSweepAllCrdtNotes` falls through to a *persisted* interval stamp, so
   * a restart inside that interval with no reconnect gap queues no pulls at all.
   * A single edit 30 s later was then enough to destroy a peer's updates.
   *
   * While this is true the answer for **every** note is "unmerged", which is the
   * same conservative answer the per-note flag gives, applied vault-wide until
   * the flags exist again. It costs those pushes the snapshot endpoint — they go
   * to `/sync/crdt/updates`, which stores and broadcasts the same bytes and
   * prunes nothing — and nothing else.
   *
   * It is dropped by the first vault-wide sweep, which queues a pull for every
   * note in the vault and so flags every one of them individually: the blanket
   * is retired because it has been made redundant, not because it went stale.
   * That sweep is at most `CRDT_FULL_SWEEP_MIN_INTERVAL_MS` away.
   *
   * Persisting the note ids instead was the obvious alternative and is worse on
   * both counts: it needs a new on-disk format in a live beta, and a crash can
   * still leave it missing whatever it had not written yet, while a boolean that
   * is already `'1'` cannot become wrong by not being written again.
   */
  get crdtUnmergedStateUnknown(): boolean {
    this.carriedUnmergedDebt ??=
      this.stateManager.getStateValue(SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT) === '1'
    return this.carriedUnmergedDebt
  }

  /**
   * Persist the coordinator's empty ↔ non-empty transitions.
   *
   * Written as they happen rather than at teardown, because the case this has to
   * survive is a session that never runs its teardown at all — a crash, a kill,
   * a power cut. A transition is two writes per sweep cycle at worst: one when
   * the sweep queues the vault, one when the paced drain finishes it.
   */
  recordCrdtUnmergedDebt(hasDebt: boolean): void {
    // An empty set is not an answer while the flags have not been rebuilt — it
    // is the emptiness this session *started* with, and clearing the key on it
    // would hand the next launch the same false "everything is merged".
    if (!hasDebt && this.crdtUnmergedStateUnknown) return
    this.stateManager.setStateValue(SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT, hasDebt ? '1' : '0')
  }

  private shouldSweepAllCrdtNotes(force: boolean): boolean {
    // Nothing is fetchable while offline. Sweeping here would schedule pulls
    // that are guaranteed to fail and then stamp the interval, hiding real
    // remote edits until the window reopened.
    if (!this.ctx.deps.network.online) return false
    if (force) return true

    const ws = this.ctx.deps.ws
    if (ws && this.lastSweepConnectionGeneration !== null) {
      // A generation past the one the last sweep saw means the socket dropped
      // and came back, so broadcasts were missed. This stays true for every
      // later cycle until a sweep actually runs and re-reads the generation —
      // which is what carries an unpaid debt forward, no extra flag needed.
      if (this.hasReconnectGap()) {
        // Due, but not necessarily now: a connection flapping every few seconds
        // would buy one full O(vault) pass per flap. Hold it to one per floor
        // and remember the debt — dropping it would strand whatever changed
        // during the gap. The floor counts from the last reconnect sweep, so an
        // isolated drop is served at once however recently the vault was swept
        // for some other reason.
        if (this.msSinceReconnectSweep() >= CRDT_RECONNECT_SWEEP_FLOOR_MS) return true
        this.deferOwedSweep()
        return false
      }

      // Same socket as the last sweep and still up: no broadcast could have
      // been missed in between, whatever the clock says.
      if (ws.connected) return false
    }

    // Trigger unknowable: no sweep recorded against this runner yet, no socket
    // manager, or a socket that went down and has not reconnected. Note that
    // "no sweep recorded yet" must NOT mean "sweep now" — this runner is
    // rebuilt with every engine (vault switch, restart, retry), and an
    // instance-only signal that re-armed here would sweep the whole vault on
    // every cycle of a retry loop, the same trap documented on
    // lastManifestCheckAt above. The persisted stamp is the authority.
    return this.msSinceLastSweep() >= CRDT_FULL_SWEEP_MIN_INTERVAL_MS
  }

  private msSinceLastSweep(): number {
    const persistedRaw = Number(
      this.stateManager.getStateValue(SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT) ?? '0'
    )
    const now = Date.now()
    // A future-dated stamp (clock skew, machine migration) is not a sweep that
    // happened — treated as "never swept" so the safety net cannot be parked
    // until the wall clock catches up. Clamping to now would not help: the
    // elapsed time stays pinned at zero for exactly as long.
    const lastSweepAt = Number.isFinite(persistedRaw) && persistedRaw <= now ? persistedRaw : 0
    return now - lastSweepAt
  }

  /** Did the socket drop and come back since the last sweep read its generation? */
  private hasReconnectGap(): boolean {
    const ws = this.ctx.deps.ws
    if (!ws || this.lastSweepConnectionGeneration === null) return false
    return ws.connectionGeneration !== this.lastSweepConnectionGeneration
  }

  private msSinceReconnectSweep(): number {
    // Never swept for a reconnect on this runner: the floor has nothing to
    // collapse yet, so the first drop is owed a sweep immediately.
    if (this.lastReconnectSweepAt === null) return Number.POSITIVE_INFINITY
    return Date.now() - this.lastReconnectSweepAt
  }

  /** Hold an owed sweep until the floor expires, without losing it. */
  private deferOwedSweep(): void {
    this.crdtSweepOwed = true
    // One timer, re-used: a flapping connection must not stack a timer per flap.
    if (this.owedSweepTimer) return

    const waitMs = Math.max(0, CRDT_RECONNECT_SWEEP_FLOOR_MS - this.msSinceReconnectSweep())
    this.owedSweepTimer = setTimeout(() => {
      this.owedSweepTimer = null
      this.payOwedSweep()
    }, waitMs)
    this.owedSweepTimer.unref?.()
  }

  private payOwedSweep(): void {
    if (!this.crdtSweepOwed) return
    // Keep the debt rather than sweep into a wall: a fullSync in flight would
    // have its scheduleSync calls dropped (the engine ignores them while
    // fullSyncActive) and offline pulls cannot succeed. Both states end in
    // another fullSync, whose finally pays the debt with the floor long past.
    if (this.ctx.fullSyncActive || !this.ctx.deps.network.online) return
    if (!this.ctx.deps.crdtProvider || !isIndexDatabaseInitialized()) return

    log.debug('fullSync: paying owed CRDT sweep after reconnect floor')
    this.sweepAllCrdtNotes()
    this.flushPendingCrdtPulls()
  }

  /** Clears the deferred sweep and paced-pull timers. Call on engine teardown. */
  dispose(): void {
    if (this.owedSweepTimer) {
      clearTimeout(this.owedSweepTimer)
      this.owedSweepTimer = null
    }
    if (this.pacedCrdtPullTimer) {
      clearTimeout(this.pacedCrdtPullTimer)
      this.pacedCrdtPullTimer = null
    }
    // Drop the plan with the engine that made it. Leaving ids here would let a
    // chunk still in flight re-arm the pace timer from its `finally` and keep a
    // dead engine pulling against a vault it no longer owns.
    this.pacedCrdtPullQueue.clear()
    this.pacedCrdtPullAbort?.abort()
    this.pacedCrdtPullAbort = null
    // A vault switch / runtime restart revokes the elevated session (#1837):
    // local pacing reverts synchronously, the server close is best-effort and
    // must not delay teardown.
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
   * Has any vault-wide sweep run on this engine? Gates the bootstrap
   * full-text mark: before the first sweep, an empty paced queue means
   * "nothing queued yet" (an offline first sync, a refused pull), not
   * "every body is current".
   */
  private sweptOnThisEngine = false

  /**
   * Has a pull actually RESOLVED on this engine? Gates the bootstrap
   * full-text mark alongside `sweptOnThisEngine`: a sweep proves it ran,
   * never that the pull delivered — and on a fresh device an empty index DB
   * makes every sweep drain trivially, so only pull success is evidence that
   * any body was fetched at all.
   */
  private bootstrapPullSucceeded = false

  private sweepAllCrdtNotes(): void {
    this.sweptOnThisEngine = true
    // Read before the generation is re-stamped below: only a sweep that closes
    // a real drop/reconnect gap starts the floor for the next one.
    if (this.hasReconnectGap()) this.lastReconnectSweepAt = Date.now()
    for (const noteId of getAllCrdtNoteIds(getIndexDatabase())) {
      this.crdtSync.addPendingPull(noteId)
    }
    // Every note in the vault now carries its own flag, so the vault-wide
    // blanket a carried-over debt raised has nothing left to cover. Dropped
    // after the loop and never before it: in between, a push would read a
    // not-yet-flagged note as safe to snapshot.
    this.carriedUnmergedDebt = false
    // Re-state the key from this session's own set now that it is authoritative.
    // Without this, a sweep that flags nothing — an empty vault, or one whose
    // notes all cleared before the key was ever written — would leave the
    // previous session's `'1'` standing and blanket every launch from here on.
    this.recordCrdtUnmergedDebt(this.crdtSync.hasUnmergedNotes)
    this.lastSweepConnectionGeneration = this.ctx.deps.ws?.connectionGeneration ?? null
    this.crdtSweepOwed = false
    this.stateManager.setStateValue(SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT, String(Date.now()))
  }

  /**
   * `forceCrdtSweep` is for a sync the user asked for by name. The throttle on
   * the vault-wide sweep exists to stop an automatic reconnect loop buying one
   * O(vault) pass per flap; it was never meant to make "Sync now" incomplete.
   * Without it that button can skip the only discovery path for body-only
   * remote edits — bodies never travel in the record change feed — and leave a
   * note reading stale for up to CRDT_FULL_SWEEP_MIN_INTERVAL_MS with the app
   * reporting a clean sync.
   */
  async run(options: { forceCrdtSweep?: boolean } = {}): Promise<void> {
    log.debug('fullSync started')
    // No persisted cursor = this device has never completed a pull for this
    // vault: a genuine fresh-device bootstrap (#1835). beginBootstrap no-ops
    // while a window is already open (the vault-download seam fires earlier
    // and keeps the truer start time), and telemetry must never break sync.
    const isFreshDevice = this.stateManager.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR) == null
    try {
      if (isFreshDevice) {
        beginBootstrap('first_full_sync')
        // Elevated limits + presigned sets for this pull (#1837). Any failure
        // — old server, unconfigured, capped, offline — silently falls back to
        // steady-state pacing; nothing downstream may depend on it succeeding.
        await openBootstrapSession(this.ctx.deps.getAccessToken)
      }
    } catch {
      /* telemetry only — sync proceeds */
    }
    this.ctx.fullSyncActive = true
    // A manifest re-pull means the server holds items this device has never
    // seen (fresh install, restored vault, rebuilt index): local CRDT state
    // cannot be trusted, so the sweep runs regardless of the throttle.
    let forceCrdtSweep = options.forceCrdtSweep === true
    try {
      await this.actions.pull()
      // Evidence for the full-text mark: this pull resolved, so whatever the
      // sweeps drain from here on was actually delivered by the server.
      this.bootstrapPullSucceeded = true
      log.debug('fullSync: pull complete')

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
        isQuarantined: this.isQuarantined
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
      log.debug('fullSync: manifest check complete', {
        rePullNeeded: manifestResult.rePullNeeded,
        serverOnlyCount: manifestResult.serverOnlyCount
      })

      if (manifestResult.rePullNeeded) {
        forceCrdtSweep = true
        log.info('fullSync: manifest detected server-only items, resetting cursor for re-pull', {
          serverOnlyCount: manifestResult.serverOnlyCount
        })
        this.stateManager.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
        await this.actions.pull()
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
      if (!this.bootstrapPullSucceeded) abandonBootstrap()
      // Same for the elevated session: a failed run releases it immediately,
      // so pacing reverts before the next cycle starts (#1837).
      await closeBootstrapSession('failed')
      throw error
    } finally {
      this.ctx.fullSyncActive = false
      if (
        this.ctx.deps.crdtProvider &&
        isIndexDatabaseInitialized() &&
        this.shouldSweepAllCrdtNotes(forceCrdtSweep)
      ) {
        this.sweepAllCrdtNotes()
      }
      this.flushPendingCrdtPulls()
    }
  }

  /**
   * Always runs, gate or no gate: the set holds notes the server named in a
   * `crdt_updated` broadcast, which is a positive signal about that specific
   * note rather than the blanket safety net, alongside whatever the sweep just
   * queued and whatever a failed chunk owes.
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
  private flushPendingCrdtPulls(): void {
    if (this.crdtSync.pendingPullCount > 0) {
      log.debug('fullSync: flushing pending CRDT pulls', {
        count: this.crdtSync.pendingPullCount
      })

      // A note with a live editor is the one the user is looking at, and a stale
      // body there is the whole bug. It must not queue behind a catch-up that
      // takes minutes on a large vault, so it skips the pace entirely. The cost
      // is bounded by the number of open editors — a handful — which is what the
      // headroom described on CRDT_SWEEP_CHUNK_NOTES is for.
      // SyncEngine.handleWsConnected reads the same set for the same reason.
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
        this.actions.scheduleSync(async () => {
          // Its cost is deliberately discarded: this batch jumps the pace by
          // design — the note the user is looking at must not wait behind a
          // catch-up — and it is bounded by the number of open editors, which
          // is what the other half of each bucket's margin is reserved for.
          await this.crdtSync.pullCrdtForNotes(priority, this.sweepPullSignal())
        })
      }
    }

    this.pumpPacedCrdtPulls()
    this.maybeMarkBootstrapFullText()
  }

  /**
   * Bootstrap seam (#1835): the sweep queue draining to empty — with a sweep
   * actually run and nothing owed back to the pending set — is the moment
   * every note body the server holds is current on this device. The metrics
   * module makes this a no-op outside an active fresh-device bootstrap, so
   * steady-state cycles pay one boolean check.
   *
   * The elevated session (#1837) closes at the same moment: full-text is the
   * definition of "bootstrap done", and closing releases the per-user session
   * slot while reverting every pacing site in the same tick.
   */
  private maybeMarkBootstrapFullText(): void {
    if (!this.sweptOnThisEngine) return
    // The sweep gate proves a sweep RAN; on a fresh device an empty index DB
    // makes every sweep drain trivially, failed pull or not. Only a pull that
    // actually resolved turns "queue empty" into "bodies delivered".
    if (!this.bootstrapPullSucceeded) return
    if (this.pacedCrdtChunkInFlight || this.pacedCrdtPullQueue.size > 0) return
    if (this.crdtSync.pendingPullCount > 0) return
    markBootstrapFullText()
    void closeBootstrapSession('completed')
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
    if (this.pacedCrdtPullTimer || this.pacedCrdtChunkInFlight) return
    if (this.pacedCrdtPullQueue.size === 0) return

    const crdtProvider = this.ctx.deps.crdtProvider
    // The same wall `payOwedSweep` refuses to run into: `scheduleSync` silently
    // drops its callback while a fullSync is active, and pulls issued offline
    // are guaranteed to fail. Keep the queue intact and look again next tick
    // rather than spending a chunk on a request that cannot land.
    if (this.ctx.fullSyncActive || !this.ctx.deps.network.online || !crdtProvider) {
      this.armPacedCrdtPullTimer()
      return
    }

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
