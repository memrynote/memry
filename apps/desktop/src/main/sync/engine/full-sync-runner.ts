import { createLogger } from '../../lib/logger'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import type { InitialSyncProgressEvent } from '@memry/contracts/ipc-events'
import { ERROR_RETENTION_DAYS } from '../queue'
import { checkManifestIntegrity } from '../manifest-check'
import { runInitialSeed } from '../initial-seed'
import type { SyncContext } from './sync-context'
import {
  CRDT_FULL_SWEEP_MIN_INTERVAL_MS,
  CRDT_RECONNECT_SWEEP_FLOOR_MS,
  CRDT_SWEEP_CHUNK_INTERVAL_MS,
  CRDT_SWEEP_CHUNK_NOTES,
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
   * FIFO. In-memory by design: this queue is a plan for the current engine's
   * catch-up, and the persisted sweep stamp is what carries the work across a
   * restart.
   */
  private pacedCrdtPullQueue = new Set<string>()
  private pacedCrdtPullTimer: ReturnType<typeof setTimeout> | null = null
  private pacedCrdtChunkInFlight = false

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
  }

  private sweepAllCrdtNotes(): void {
    // Read before the generation is re-stamped below: only a sweep that closes
    // a real drop/reconnect gap starts the floor for the next one.
    if (this.hasReconnectGap()) this.lastReconnectSweepAt = Date.now()
    for (const noteId of getAllCrdtNoteIds(getIndexDatabase())) {
      this.crdtSync.addPendingPull(noteId)
    }
    this.lastSweepConnectionGeneration = this.ctx.deps.ws?.connectionGeneration ?? null
    this.crdtSweepOwed = false
    this.stateManager.setStateValue(SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT, String(Date.now()))
  }

  async run(): Promise<void> {
    log.debug('fullSync started')
    this.ctx.fullSyncActive = true
    // A manifest re-pull means the server holds items this device has never
    // seen (fresh install, restored vault, rebuilt index): local CRDT state
    // cannot be trusted, so the sweep runs regardless of the throttle.
    let forceCrdtSweep = false
    try {
      await this.actions.pull()
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
   * server's `crdt_pull` bucket of 300 per 60s, shared with the account's other
   * devices — 92 of those 121 notes came back "Too many requests" and, before
   * the re-queue above, kept a stale body until the next sweep.
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

      const priority: string[] = []
      for (const noteId of this.crdtSync.drainPendingPulls()) {
        if (activeNoteIds.has(noteId)) priority.push(noteId)
        else this.pacedCrdtPullQueue.add(noteId)
      }

      if (priority.length > 0) {
        this.actions.scheduleSync(() => this.crdtSync.pullCrdtForNotes(priority))
      }
    }

    this.pumpPacedCrdtPulls()
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

    // Never hand `applyCrdtBatch` more notes than the provider can hold open at
    // once: it would split the chunk internally and spend an extra batch POST
    // doing so, which is exactly the request the pacing arithmetic budgets for.
    const chunkSize = Math.max(
      1,
      Math.min(CRDT_SWEEP_CHUNK_NOTES, crdtProvider.inactiveDocCapacity)
    )
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
      try {
        await this.crdtSync.pullCrdtForNotes(chunk)
      } finally {
        // Re-arm from the chunk's completion, not from when it was issued, so a
        // slow chunk stretches the interval instead of overlapping the next one.
        // Notes this chunk failed are back in the pending set by now, not in the
        // queue: they are owed to the next cycle, deliberately, because retrying
        // them here would just re-run into whatever refused them.
        this.pacedCrdtChunkInFlight = false
        this.armPacedCrdtPullTimer()
      }
    })
  }

  private armPacedCrdtPullTimer(): void {
    if (this.pacedCrdtPullTimer || this.pacedCrdtPullQueue.size === 0) return

    this.pacedCrdtPullTimer = setTimeout(() => {
      this.pacedCrdtPullTimer = null
      this.pumpPacedCrdtPulls()
    }, CRDT_SWEEP_CHUNK_INTERVAL_MS)
    this.pacedCrdtPullTimer.unref?.()
  }
}
