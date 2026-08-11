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
   * A reconnect gap was seen inside the floor and the deferred timer has not
   * paid it yet. Cleared by any sweep, so a fullSync that arrives past the
   * floor first settles the debt and the pending timer becomes a no-op instead
   * of sweeping the vault a second time.
   */
  private crdtSweepOwed = false
  private owedSweepTimer: ReturnType<typeof setTimeout> | null = null

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
      if (ws.connectionGeneration !== this.lastSweepConnectionGeneration) {
        // Due, but not necessarily now: a connection flapping every few seconds
        // would buy one full O(vault) pass per flap. Hold it to one per floor
        // and remember the debt — dropping it would strand whatever changed
        // during the gap.
        if (this.msSinceLastSweep() >= CRDT_RECONNECT_SWEEP_FLOOR_MS) return true
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

  /** Hold an owed sweep until the floor expires, without losing it. */
  private deferOwedSweep(): void {
    this.crdtSweepOwed = true
    // One timer, re-used: a flapping connection must not stack a timer per flap.
    if (this.owedSweepTimer) return

    const waitMs = Math.max(0, CRDT_RECONNECT_SWEEP_FLOOR_MS - this.msSinceLastSweep())
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

  /** Clears the deferred sweep timer. Call on engine teardown. */
  dispose(): void {
    if (this.owedSweepTimer) {
      clearTimeout(this.owedSweepTimer)
      this.owedSweepTimer = null
    }
  }

  private sweepAllCrdtNotes(): void {
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
   * Always runs, gate or no gate: these are notes the server named in a
   * `crdt_updated` broadcast, which is a positive signal about that specific
   * note rather than the blanket safety net.
   */
  private flushPendingCrdtPulls(): void {
    if (this.crdtSync.pendingPullCount === 0) return
    log.debug('fullSync: flushing pending CRDT pulls', {
      count: this.crdtSync.pendingPullCount
    })
    for (const noteId of this.crdtSync.drainPendingPulls()) {
      this.actions.scheduleSync(() => this.crdtSync.pullCrdtForNote(noteId))
    }
  }
}
