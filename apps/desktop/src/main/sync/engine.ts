import { SyncEventEmitter } from '@memry/sync-client/emitter'
import { createSyncAdapterRegistry } from '@memry/sync-core'
import { createLogger } from '../lib/logger'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import type {
  CertificatePinFailedEvent,
  LinkingApprovedEvent,
  LinkingRequestEvent,
  QuarantinedItemInfo
} from '@memry/contracts/ipc-events'
import type {
  GetSyncStatusResult,
  PauseSyncResult,
  ResumeSyncResult,
  SyncStatusValue
} from '@memry/contracts/ipc-sync-ops'
import type { QueueStats } from '@memry/sync-client/queue'
import type { SyncSocketEvent } from '@memry/contracts/sync-socket'
import { secureCleanup } from '../crypto/index'
import { getFromServer } from './http-client'
import { classifyError } from './sync-errors'
import { syncErrorTelemetryFor } from './sync-error-telemetry'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { ItemApplier } from './apply-item'
import { FullSyncRunner } from './engine/full-sync-runner'
import type { SyncContext, SyncEngineDeps, SyncEngineOptions } from './engine/sync-context'
import {
  NOTE_BODY_LEGACY_SWEEP_DONE,
  PUSH_BATCH_SIZE,
  PULL_PAGE_LIMIT,
  STALE_CURSOR_THRESHOLD_MS,
  SYNC_STATE_KEYS
} from './engine/sync-context'
import { SyncStateManager } from './engine/sync-state-manager'
import { QuarantineManager } from './engine/quarantine-manager'
import { CrdtSyncCoordinator } from './engine/crdt-sync-coordinator'
import { isKnownNote } from './note-body-apply'
import { crdtBodyDebtStore } from './engine/crdt-body-debts'
import { PushCoordinator } from './engine/push-coordinator'
import { PullCoordinator } from './engine/pull-coordinator'
import { ErrorRecoveryHandler } from './engine/error-recovery-handler'
import { createSocketApplier, type SocketApplier } from './engine/socket-apply'
import { reportConflict } from './engine/conflict-report'
import { trackMainEvent } from '../telemetry/track'
import type { SnapshotCoverage, SnapshotRefusal } from './crdt-provider'

export type { SyncEngineDeps, SyncEngineOptions }

const log = createLogger('SyncEngine')
// Nothing in the main process subscribes to the engine today — status reaches
// the renderer through `emitToRenderer`, not through listeners. Keeping the
// ceiling at Node's default leaves headroom without hiding an accumulating
// subscriber behind a silent budget. See src/main/sync/emitter-budget.test.ts.
const MAX_SYNC_ENGINE_LISTENERS = 10

// A sync run legitimately spans many paged requests plus retry backoff, so
// this sits far above SYNC_REQUEST_TIMEOUT_MS × the retry budget. A lock held
// longer than this is leaked (a never-settling non-HTTP await): left alone it
// makes periodicPull skip forever, and only an app restart recovers.
export const SYNC_LOCK_STALE_MS = 15 * 60 * 1000

// Floor between two pulls issued by the 60s tick while the socket has been
// continuously up.
//
// The tick's pull exists to heal a `changes_available` broadcast that never
// arrived. When the same socket is still connected as at the previous tick
// (`connectionGeneration` unchanged, `connected` true) no broadcast could have
// been missed: the socket pings every 25s and terminates itself after 31s of
// silence, so a half-open connection reports disconnected long before a tick
// would trust it. The pull is then a guaranteed-empty request, once a minute,
// per device, for the life of the app.
//
// Throttled rather than dropped, because one failure mode is not observable
// from here: a server that stops broadcasting looks exactly like a quiet vault.
// A floor keeps that self-heal — along with the deferred-apply retries and
// orphan repair that ride on the same pull — alive at a fifth of the cost, with
// a bounded worst case. Any drop between ticks bumps the generation and
// restores the every-tick pull, and the reconnect itself already pulls.
export const PERIODIC_PULL_MAX_QUIET_MS = 5 * 60 * 1000

export class SyncEngine extends SyncEventEmitter {
  private static activeInstance: SyncEngine | null = null

  private ctx: SyncContext
  private stateManager: SyncStateManager
  private quarantine: QuarantineManager
  private crdtSync: CrdtSyncCoordinator
  private pushCoordinator: PushCoordinator
  private pullCoordinator: PullCoordinator
  private errorRecovery: ErrorRecoveryHandler
  private fullSyncRunner: FullSyncRunner
  private socketApply: SocketApplier
  private pullInterval: ReturnType<typeof setInterval> | null = null
  private networkReconnectAbortController: AbortController | null = null
  /**
   * Latched by requestCancel() for the rest of this engine's life.
   *
   * Aborting alone is not enough to stop a fullSync: every cycle opens a FRESH
   * AbortController (PullCoordinator.pull), so the phases that follow an aborted
   * one — seed push, manifest check, its re-pull, the follow-up push — would
   * each start new pulls and runs against a runtime teardown is trying to stop.
   * The latch makes acquireSyncLock refuse them all. Never reset: an engine is
   * built per runtime start and discarded at teardown (vault switch, quit,
   * close-during-initial-sync), so a fresh engine means a fresh latch.
   */
  private cancelRequested = false
  private syncLockAcquiredAt: number | null = null
  private activeLockRelease: (() => void) | null = null
  // The socket generation the previous pull tick observed, and when the tick
  // last actually pulled. Both are instance state re-armed with the interval —
  // see armPeriodicPull.
  private lastPullTickWsGeneration: number | null = null
  private lastPullTickPullAt = 0
  /**
   * The highest cursor of the wakes no pull has taken yet (#2290, #2421);
   * Infinity for a wake with no cursor, or a reconnect a full sync refused.
   * Non-null means a wake pull is queued or a running full sync's `finally`
   * schedules one, so more wakes only raise it. The queued pull takes and
   * clears it as it starts, so wakes during a running pull queue exactly one
   * more; a pull a full sync refused or overlapped puts it back.
   */
  private pendingWakeCursor: number | null = null
  /**
   * The highest `crdt_updated` wake cursor per note, session-only (#2421). The
   * note is unmerged until LAST_CURSOR reaches it: from then on its body
   * either landed or left the note flagged or owed.
   */
  private wakeCursorByNote = new Map<string, number>()

  constructor(deps: SyncEngineDeps, options?: Partial<SyncEngineOptions>) {
    super()
    this.setMaxListeners(MAX_SYNC_ENGINE_LISTENERS)
    if (SyncEngine.activeInstance && SyncEngine.activeInstance.ctx.syncing) {
      throw new Error('SyncEngine instance already active — call stop() before creating a new one')
    }

    const adapters = deps.adapters ?? createSyncAdapterRegistry([])

    const resolvedOptions: SyncEngineOptions = {
      pushBatchSize: options?.pushBatchSize ?? PUSH_BATCH_SIZE,
      pullPageLimit: options?.pullPageLimit ?? PULL_PAGE_LIMIT
    }

    this.ctx = {
      deps: { ...deps, adapters },
      options: resolvedOptions,
      applier: new ItemApplier(deps.db, deps.emitToRenderer, adapters),
      state: 'idle',
      syncing: false,
      fullSyncActive: false,
      abortController: null,
      inFlightSync: null,
      lastError: undefined,
      lastErrorInfo: undefined,
      offlineSince: null,
      rateLimitConsecutive: 0,
      scheduleSync: (fn) => this.scheduleSync(fn),
      acquireLock: () => this.acquireSyncLock(),
      releaseLock: () => this.releaseLock(),
      requestPush: () => this.requestPush()
    }

    this.stateManager = new SyncStateManager(this.ctx, (event, ...args) =>
      this.emit(event, ...args)
    )
    this.quarantine = new QuarantineManager(this.ctx)
    this.pullCoordinator = new PullCoordinator(
      this.ctx,
      this.stateManager,
      this.quarantine,
      null as unknown as CrdtSyncCoordinator,
      null as unknown as PushCoordinator
    )
    this.crdtSync = new CrdtSyncCoordinator(
      this.ctx,
      (id) => this.pullCoordinator.resolveDeviceKey(id),
      (id) => isKnownNote(this.ctx.deps.db, id),
      crdtBodyDebtStore(this.ctx.deps.db)
    )
    this.pushCoordinator = new PushCoordinator(this.ctx, this.stateManager)
    // Wire up the circular dependencies now that all collaborators exist
    ;(this.pullCoordinator as unknown as { crdtSync: CrdtSyncCoordinator }).crdtSync = this.crdtSync
    ;(this.pullCoordinator as unknown as { pushCoordinator: PushCoordinator }).pushCoordinator =
      this.pushCoordinator

    this.errorRecovery = new ErrorRecoveryHandler(this.ctx, this.stateManager, () =>
      this.scheduleSync(() => this.fullSync())
    )
    this.fullSyncRunner = new FullSyncRunner(
      this.ctx,
      this.stateManager,
      this.pushCoordinator,
      this.crdtSync,
      {
        pull: () => this.pull(),
        push: () => this.push(),
        scheduleSync: (fn) => this.scheduleSync(fn)
      },
      (itemId, itemType) =>
        this.quarantine.isQuarantined(itemId, itemType) ||
        this.pullCoordinator.schemaInvalid.has(itemType, itemId)
    )
    this.pullCoordinator.onNoteBodyLegacySweepReset = () =>
      this.fullSyncRunner.resetNoteBodyLegacySweep()
    this.ctx.doPush = () => this.push()
    this.socketApply = createSocketApplier({
      db: this.ctx.deps.db,
      applier: this.ctx.applier,
      appliedCursor: () =>
        Math.max(
          Number(this.stateManager.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR) ?? 0),
          this.pullCoordinator.ownedThrough
        ),
      eligible: () =>
        SyncEngine.activeInstance === this &&
        !this.cancelRequested &&
        !this.ctx.fullSyncActive &&
        !this.stateManager.isPaused() &&
        this.ctx.deps.network.online,
      pushInFlight: () => this.pushCoordinator.pushInFlight,
      whenPushSettled: (timeoutMs) => this.pushCoordinator.whenPushSettled(timeoutMs),
      isQuarantined: (id, type) => this.quarantine.isQuarantined(id, type),
      getVaultKey: () => this.ctx.deps.getVaultKey(),
      getDevicePublicKey: (id) => this.ctx.deps.getDevicePublicKey(id),
      workerBridge: this.ctx.deps.workerBridge,
      setPushSuppressed: (suppressed) => {
        this.pushCoordinator.suppressPushDuringPull = suppressed
      },
      isPushSuppressed: () => this.pushCoordinator.suppressPushDuringPull,
      onApplied: (dec, op) => this.stateManager.emitItemSynced(dec.id, dec.type, 'pull', op),
      onConflict: (dec, page) =>
        reportConflict(
          {
            ...this.ctx.deps,
            emitToRenderer: (channel, event) =>
              page.afterCommit(() => this.ctx.deps.emitToRenderer(channel, event))
          },
          dec
        ),
      requestPush: () => this.ctx.requestPush(),
      oweRecordBody: (noteId) => this.crdtSync.oweRecordBody(noteId)
    })
    SyncEngine.activeInstance = this
  }

  private async isAuthReady(): Promise<boolean> {
    const [token, signingKeys] = await Promise.all([
      this.ctx.deps.getAccessToken(),
      this.ctx.deps.getSigningKeys()
    ])
    return token !== null && signingKeys !== null
  }

  get currentState(): SyncStatusValue {
    return this.ctx.state
  }

  // --- Lifecycle ---

  async start(): Promise<void> {
    this.ctx.deps.network.on('status-changed', this.handleNetworkChange)
    this.ctx.deps.ws.on('message', this.handleWsMessage)
    this.ctx.deps.ws.on('connected', this.handleWsConnected)
    this.ctx.deps.ws.on('device_revoked', this.handleDeviceRevokedFromWs)
    this.ctx.deps.ws.on('certificate_pin_failed', this.handleCertPinFailed)

    // Before any sync and whatever the auth or network state: the debts decide
    // which snapshot pushes may prune, and the first full sync pays them.
    if (this.stateManager.reconcileNoteBodyFeedCursor()) {
      log.info('LAST_CURSOR was moved by another build: the note-body legacy sweep re-arms')
    }
    this.fullSyncRunner.loadCrdtBodyDebts()
    this.quarantine.loadState()

    if (!(await this.isAuthReady())) {
      this.stateManager.setState('idle')
      return
    }

    if (this.ctx.deps.network.online) {
      const deviceStatus = await this.checkDeviceStatus()
      if (deviceStatus === 'revoked') {
        log.warn('SECURITY_AUDIT: Device revoked detected at launch')
        this.handleDeviceRevoked()
        this.emit('device_revoked_on_launch')
        return
      }

      await this.ctx.deps.ws.connect()
      // Armed before the first full sync: if that sync fails, the 60s tick is
      // what heals sync for the rest of the session.
      this.armPeriodicPull()
      if (!this.stateManager.isPaused()) {
        try {
          await this.fullSync()
        } catch (error) {
          // A throw here used to propagate out of start() and tear down the
          // whole sync runtime, so one transient 429 or offline blip during
          // the first sync left sync dead until restart. Revocation and auth
          // failures still surface via WS events and the next pull cycle.
          log.error('Initial full sync failed — periodic pull will retry', error)
        }
      }
    } else {
      this.stateManager.setState('offline')
    }
  }

  async activate(): Promise<void> {
    if (this.ctx.syncing) return
    if (!(await this.isAuthReady())) return

    if (this.ctx.deps.network.online) {
      this.stateManager.setState('idle')
      await this.ctx.deps.ws.connect()
      if (!this.stateManager.isPaused()) {
        await this.fullSync()
      }
    }
  }

  async stop(options?: { skipFinalPush?: boolean }): Promise<void> {
    this.pushCoordinator.stop()
    if (this.pullInterval) {
      clearInterval(this.pullInterval)
      this.pullInterval = null
    }
    this.errorRecovery.clearRateLimitState()
    this.networkReconnectAbortController?.abort()
    this.networkReconnectAbortController = null

    this.ctx.abortController?.abort()
    if (this.ctx.inFlightSync) {
      await this.ctx.inFlightSync.catch(() => {})
    }
    this.ctx.abortController = null
    this.ctx.inFlightSync = null

    const skipPush =
      options?.skipFinalPush ||
      !this.ctx.deps.network.online ||
      this.ctx.lastErrorInfo?.category === 'device_revoked'

    if (!skipPush) {
      const pending = this.ctx.deps.queue.getPendingCount()
      if (pending > 0) {
        log.info(`Shutdown: attempting final push of ${pending} item(s)`)
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), 2000)
        this.ctx.abortController = ac
        try {
          await this.push()
        } catch {
          log.warn('Shutdown: final push failed (non-fatal)')
        }
        clearTimeout(timer)
        this.ctx.abortController = null
      }
    }

    const remaining = this.ctx.deps.queue.getPendingCount()
    if (remaining > 0) {
      log.warn(`Shutdown: ${remaining} sync item(s) deferred to next startup`)
    }

    this.ctx.deps.network.removeListener('status-changed', this.handleNetworkChange)
    this.ctx.deps.ws.removeListener('message', this.handleWsMessage)
    this.ctx.deps.ws.removeListener('connected', this.handleWsConnected)
    this.ctx.deps.ws.removeListener('device_revoked', this.handleDeviceRevokedFromWs)
    this.ctx.deps.ws.removeListener('certificate_pin_failed', this.handleCertPinFailed)
    this.ctx.deps.ws.disconnect()
    this.fullSyncRunner.dispose()
    this.pullCoordinator.clearCaches()
    this.crdtSync.clearCaches()
    this.quarantine.clear()
    this.ctx.syncing = false
    this.stateManager.setState('idle')
    SyncEngine.activeInstance = null
  }

  // --- Public sync operations (delegated) ---

  async push(): Promise<void> {
    const start = Date.now()
    const startingPending = this.ctx.deps.queue.getPendingCount()
    try {
      await this.pushCoordinator.push()
      trackMainEvent('sync_run_completed', {
        surface: 'sync',
        action: 'push_completed',
        result: 'success',
        metrics: {
          durationMs: Date.now() - start,
          queueCount: this.ctx.deps.queue.getPendingCount(),
          itemCount: Math.max(0, startingPending - this.ctx.deps.queue.getPendingCount())
        },
        source: 'push',
        dimensions: { transport: 'record' }
      })
    } catch (error) {
      trackMainEvent('sync_error', {
        surface: 'sync',
        action: 'push_failed',
        result: 'failed',
        ...syncErrorTelemetryFor(error),
        metrics: { durationMs: Date.now() - start },
        source: 'push',
        dimensions: { transport: 'record' }
      })
      await this.handleCoordinatorError(error)
    }
  }

  /**
   * Resolves TRUE only when the pull actually delivered. Every failure below is
   * swallowed exactly as it always has been — `handleCoordinatorError` returns
   * from every branch — so the returned outcome is the only thing that
   * separates a delivered pull from a silent one (#1835).
   */
  async pull(): Promise<boolean> {
    const start = Date.now()
    try {
      const delivered = await this.pullCoordinator.pull()
      trackMainEvent('sync_run_completed', {
        surface: 'sync',
        action: 'pull_completed',
        result: 'success',
        metrics: {
          durationMs: Date.now() - start,
          queueCount: this.ctx.deps.queue.getPendingCount()
        },
        source: 'pull',
        dimensions: { transport: 'record' }
      })
      return delivered
    } catch (error) {
      trackMainEvent('sync_error', {
        surface: 'sync',
        action: 'pull_failed',
        result: 'failed',
        ...syncErrorTelemetryFor(error),
        metrics: { durationMs: Date.now() - start },
        source: 'pull',
        dimensions: { transport: 'record' }
      })
      await this.handleCoordinatorError(error)
      return false
    }
  }

  requestPush(): void {
    this.pushCoordinator.requestPush()
  }

  /**
   * Prompt whatever cycle is running to stop, and keep later cycles from
   * starting.
   *
   * This is teardown's prompt, not a pause: stopSyncRuntime used to await the
   * in-flight startPromise before touching anything, and that startPromise
   * includes the engine's entire first fullSync — so closing or switching a
   * vault seconds into a fresh-vault pull stalled the close IPC for the whole
   * minutes-long pull. Called BEFORE that await, it aborts the active cycle's
   * controller (pull loops observe it between pages and batches) and latches
   * `cancelRequested`, so the phases after the abort cannot open a fresh
   * controller and start pulling again.
   */
  requestCancel(): void {
    if (this.cancelRequested) return
    this.cancelRequested = true
    log.info('Sync cancel requested — aborting in-flight sync and refusing further cycles')
    this.ctx.abortController?.abort()
  }

  /**
   * Pull and merge one note's server-side CRDT state into the local doc, and
   * say whether that actually completed.
   *
   * Exists for the pending-note replay, which must not push a snapshot for a
   * note it has not merged first: the server prunes every `crdt_updates` row at
   * or below a stored snapshot's sequence number, so a snapshot pushed over an
   * unmerged peer edit deletes that edit for every device. Deliberately NOT
   * routed through `scheduleSync`: the replay is fire-and-forget at the end of
   * startup and must not queue behind — or in front of — a sync cycle. The
   * paced vault sweep calls the coordinator directly for the same reason.
   */
  async mergeRemoteCrdtForNote(noteId: string): Promise<boolean> {
    return this.crdtSync.pullCrdtForNote(noteId)
  }

  /**
   * `true` when this device knows it has not merged the server's state for this
   * note — an unverifiable signer, a failed or aborted pass, or a pull that is
   * queued and has not run — so a snapshot push would delete or overwrite that
   * state. The CRDT snapshot push fn asks this before choosing an endpoint; see
   * `CrdtSyncCoordinator.hasUnmergedRemoteState`. A debt a previous session left
   * is answered from `crdt_body_debts`, which `start()` hydrates (#2297).
   */
  hasUnmergedRemoteCrdtState(noteId: string): boolean {
    if (this.crdtSync.hasUnmergedRemoteState(noteId)) return true
    const woken = this.wakeCursorByNote.get(noteId)
    if (woken === undefined) return false
    if (woken > Number(this.stateManager.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR) ?? 0)) {
      return true
    }
    this.wakeCursorByNote.delete(noteId)
    return false
  }

  /**
   * Snapshot refusals this session has seen (#2299), by note: the refusing
   * snapshot's feed cursor, whether the refused push carried a claim, and the
   * held snapshot revision it was encoded against. Session-only on purpose: a
   * push after a restart meets the same refusal once, which re-records it.
   */
  private snapshotRefusals = new Map<string, SnapshotRefusal>()

  /**
   * What a snapshot push of this note may claim, read at its encode (#2299).
   *
   * `coversThrough = LAST_CURSOR` is safe only while every note_body row at or
   * below it either landed in the doc or left the note flagged: the cursor is
   * written after the page's bodies land, and every body that did not land
   * (refused, owed, missing base, failed landing) flags the note first. A
   * flagged note has no known lowest unmerged cursor, so it claims nothing and
   * takes the non-pruning route. Rows below the cursor at first negotiation,
   * and NULL-cursor rows, were never served as bodies: until the legacy sweep
   * merged them all (`done`), no cursor is claimed and the push is exactly
   * the pre-#2299 one. Nor while the debts are session-only (a lost debt
   * would leave an unmerged note unflagged after a restart), nor for an id
   * the feed dropped a body of as rowless (#2421).
   *
   * A note the server refused stays on the update route until this device's
   * feed has passed the refusing snapshot's cursor (so it has merged it), or
   * its held snapshot revision (`heldRevision`, read before the encode) moved
   * off the one the refused push carried: a pull merged a newer snapshot, so
   * the push's `baseRevision` compare-and-swap passes. A refused unclaimed
   * push waits until the note can claim at all.
   */
  snapshotCoverage(noteId: string, heldRevision?: string): SnapshotCoverage {
    if (this.hasUnmergedRemoteCrdtState(noteId)) return { unmerged: true }
    const sweep = this.stateManager.getStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP)
    const cursor = Number(this.stateManager.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR) ?? 0)
    const claimable =
      sweep === NOTE_BODY_LEGACY_SWEEP_DONE &&
      Number.isSafeInteger(cursor) &&
      this.crdtSync.debtsDurable &&
      !this.crdtSync.isBodyWithheld(noteId)
    const refusal = this.snapshotRefusals.get(noteId)
    if (refusal) {
      const passed = refusal.claimed
        ? refusal.cursor === null ||
          cursor >= refusal.cursor ||
          (heldRevision !== undefined && heldRevision !== refusal.baseRevision)
        : claimable && cursor > 0
      if (!passed) return { unmerged: true }
      this.snapshotRefusals.delete(noteId)
    }
    if (!claimable || cursor <= 0) return { unmerged: false }
    return { unmerged: false, coversThrough: cursor }
  }

  /**
   * The server refused a snapshot push (#2299): the stored snapshot holds state
   * the push does not cover. The note is owed a pull, which merges it, and
   * routes to the update endpoint until `snapshotCoverage` sees the feed past
   * the refusing snapshot, so the refusal is never met again on the spot.
   */
  recordSnapshotRefusal(noteId: string, refusal: SnapshotRefusal): void {
    this.snapshotRefusals.set(noteId, refusal)
    this.crdtSync.addPendingPull(noteId, 'snapshot_refused')
  }

  /**
   * Owe a note a whole-body pull, durably, and flag it until that pull merges:
   * a note leaving local-only (#2299), whose change-feed bodies were skipped,
   * or remote updates a compaction dropped.
   */
  oweCrdtPull(noteId: string, reason: 'local_only' | 'compaction'): boolean {
    return this.crdtSync.oweWholeBody(noteId, reason)
  }

  /**
   * Flag a note without owing it a pull (#2299): a queued full-state row at
   * runtime start, whose own flush merges the server state before it pushes
   * and clears the flag.
   */
  markCrdtRemoteStateUnmerged(noteId: string): void {
    this.crdtSync.flagRemoteStateUnmerged(noteId)
  }

  /** The full-state flush dropped a note that no longer syncs: nothing will clear its flag. */
  clearCrdtUnmergedForDroppedNote(noteId: string): void {
    this.crdtSync.clearUnmergedForDroppedNote(noteId)
  }

  async fullSync(): Promise<void> {
    const start = Date.now()
    try {
      await this.fullSyncRunner.run()
      trackMainEvent('sync_run_completed', {
        surface: 'sync',
        action: 'full_completed',
        result: 'success',
        metrics: {
          durationMs: Date.now() - start,
          queueCount: this.ctx.deps.queue.getPendingCount()
        },
        source: 'full',
        dimensions: { transport: 'record' }
      })
    } catch (error) {
      trackMainEvent('sync_error', {
        surface: 'sync',
        action: 'full_failed',
        result: 'failed',
        ...syncErrorTelemetryFor(error),
        metrics: { durationMs: Date.now() - start },
        source: 'full',
        dimensions: { transport: 'record' }
      })
      throw error
    } finally {
      this.pushCoordinator.onSyncCycleEnded()
      const owed = this.pendingWakeCursor
      this.pendingWakeCursor = null
      if (owed !== null) this.scheduleWakePull(owed === Infinity ? undefined : owed)
    }
  }

  // --- Status & control ---

  getStatus(): GetSyncStatusResult {
    return {
      status: this.ctx.state,
      lastSyncAt: this.stateManager.getLastSyncAt(),
      pendingCount: this.ctx.deps.queue.getPendingCount(),
      error: this.ctx.lastError,
      errorCategory: this.ctx.lastErrorInfo?.category,
      offlineSince: this.ctx.offlineSince ?? undefined
    }
  }

  getQueueStats(): QueueStats {
    return this.ctx.deps.queue.getQueueStats()
  }

  getStateValue(key: string): string | undefined {
    return this.stateManager.getStateValue(key)
  }

  setStateValue(key: string, value: string): void {
    this.stateManager.setStateValue(key, value)
  }

  pause(): PauseSyncResult {
    const wasPaused = this.stateManager.isPaused()
    this.stateManager.setStateValue(SYNC_STATE_KEYS.SYNC_PAUSED, 'true')

    if (!wasPaused) {
      this.ctx.abortController?.abort()
      const pendingCount = this.ctx.deps.queue.getPendingCount()
      this.stateManager.emitPaused(pendingCount)
    }

    return { success: true, wasPaused }
  }

  resume(): ResumeSyncResult {
    this.stateManager.setStateValue(SYNC_STATE_KEYS.SYNC_PAUSED, 'false')
    const pendingCount = this.ctx.deps.queue.getPendingCount()
    this.stateManager.emitResumed(pendingCount)

    if (this.ctx.deps.network.online) {
      this.scheduleSync(() => this.fullSync())
    }

    return { success: true, pendingCount }
  }

  // --- Security ---

  async checkDeviceStatus(): Promise<'active' | 'revoked' | 'unknown'> {
    const token = await this.ctx.deps.getAccessToken()
    if (!token) return 'unknown'

    try {
      await getFromServer('/sync/changes?limit=1', token)
      return 'active'
    } catch (err) {
      const errorInfo = classifyError(err)
      if (errorInfo.category === 'device_revoked') {
        log.warn('SECURITY_AUDIT: Device revocation detected on status check')
        return 'revoked'
      }
      return 'unknown'
    }
  }

  async performEmergencyWipe(): Promise<void> {
    log.warn('SECURITY_AUDIT: Emergency wipe Phase 1 — zeroing in-memory keys, clearing sync state')

    this.networkReconnectAbortController?.abort()
    this.networkReconnectAbortController = null
    this.ctx.abortController?.abort()
    this.ctx.deps.ws.disconnect()

    if (this.pullInterval) {
      clearInterval(this.pullInterval)
      this.pullInterval = null
    }

    this.pullCoordinator.clearCaches()
    this.quarantine.clear()

    try {
      this.ctx.deps.db.transaction((tx) => {
        tx.delete(syncState).run()
      })
    } catch (err) {
      log.error('Emergency wipe: failed to clear sync state', {
        error: err instanceof Error ? err.message : String(err)
      })
    }

    const vaultKey = await this.ctx.deps.getVaultKey()
    if (vaultKey) secureCleanup(vaultKey)
    const signingKeys = await this.ctx.deps.getSigningKeys()
    if (signingKeys) {
      secureCleanup(signingKeys.secretKey)
      secureCleanup(signingKeys.publicKey)
    }

    this.stateManager.setState('idle')
    this.ctx.syncing = false

    log.warn('SECURITY_AUDIT: Emergency wipe Phase 1 complete')
  }

  getQuarantinedItems(): QuarantinedItemInfo[] {
    return [
      ...this.quarantine.getQuarantinedItems(),
      ...this.pullCoordinator.schemaInvalid.quarantinedItems()
    ]
  }

  // --- Internal orchestration ---

  private syncLock: Promise<void> = Promise.resolve()

  /** False when `fn` was dropped because a fullSync is running. */
  private scheduleSync(fn: () => Promise<void>): boolean {
    if (this.ctx.fullSyncActive) return false
    const run = () =>
      fn()
        .catch((error) => {
          log.error('Scheduled sync failed', error)
        })
        .finally(() => {
          this.ctx.inFlightSync = null
        })

    if (this.ctx.inFlightSync) {
      log.debug('scheduleSync: chaining onto in-flight sync')
      this.ctx.inFlightSync = this.ctx.inFlightSync.then(run)
    } else {
      this.ctx.inFlightSync = run()
    }
    return true
  }

  private scheduleWakePull(cursor: unknown): void {
    // A skip filter only, never adopted as LAST_CURSOR (protocol §9.11). Exact
    // because the server assigns cursors in commit order (#2282) and only the
    // pull moves LAST_CURSOR (#2283): every row at or below it is applied here.
    const lastCursor = Number(this.stateManager.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR) ?? 0)
    if (typeof cursor === 'number' && cursor <= lastCursor) return
    const queued = this.pendingWakeCursor !== null
    this.raiseWakeCursor(typeof cursor === 'number' ? cursor : Infinity)
    if (queued) return
    // Refused only while a full sync runs, whose `finally` takes the cursor.
    this.scheduleSync(async () => {
      const taken = this.pendingWakeCursor
      this.pendingWakeCursor = null
      // A pull queued after another took the cursor: that one read the feed.
      if (taken === null) return
      const overlapped = this.ctx.fullSyncActive
      await this.pullOutsideFullSync()
      // A full sync that held the lock refused this pull, or started while it
      // ran and may not have read past the wake: the cursor goes back.
      if (overlapped || this.ctx.fullSyncActive) this.restoreWakeCursor(taken)
    })
  }

  private raiseWakeCursor(cursor: number): void {
    this.pendingWakeCursor = Math.max(this.pendingWakeCursor ?? -Infinity, cursor)
  }

  /** A running full sync's `finally` takes it; one already over leaves it to a new pull. */
  private restoreWakeCursor(cursor: number): void {
    if (this.ctx.fullSyncActive) this.raiseWakeCursor(cursor)
    else this.scheduleWakePull(cursor === Infinity ? undefined : cursor)
  }

  /**
   * Every pull outside a full sync (a wake, a reconnect, the 60 s tick) ends
   * with the paced drain of what it owed: a feed entry past the page's GET
   * budget, a missing base (#2421). Not while a full sync runs, whose
   * `finally` flushes anyway (its `scheduleSync` would drop the drained
   * active-editor pulls), nor paused or cancelled.
   */
  private async pullOutsideFullSync(): Promise<void> {
    await this.pull()
    if (this.ctx.fullSyncActive || this.cancelRequested || this.stateManager.isPaused()) return
    this.fullSyncRunner.flushPendingCrdtPulls()
  }

  private async acquireSyncLock(): Promise<(() => void) | null> {
    if (this.cancelRequested || this.ctx.syncing || this.stateManager.isPaused()) return null
    this.ctx.syncing = true
    this.syncLockAcquiredAt = Date.now()

    let release!: () => void
    const prev = this.syncLock
    this.syncLock = new Promise((r) => {
      release = r
    })
    await prev
    this.activeLockRelease = release
    return release
  }

  private armPeriodicPull(): void {
    if (this.pullInterval) return
    // Arming always follows a pull that just ran or is about to (start(),
    // network restored), so the floor starts now rather than firing on the
    // first tick.
    this.lastPullTickWsGeneration = this.ctx.deps.ws?.connectionGeneration ?? null
    this.lastPullTickPullAt = Date.now()
    this.pullInterval = setInterval(() => this.runPullTick(), 60_000)
  }

  private runPullTick(): void {
    // An in-process watchdog with no network cost: it must keep running every
    // tick regardless of what the socket is doing.
    this.recoverStaleSyncLock()

    const ws = this.ctx.deps.ws
    const generation = ws?.connectionGeneration ?? null
    // Same socket as the previous tick and still up: nothing could have been
    // missed in between. A drop and reconnect bumps the generation; a drop
    // without one leaves `connected` false. See PERIODIC_PULL_MAX_QUIET_MS.
    const sameSocketSinceLastTick =
      generation !== null && generation === this.lastPullTickWsGeneration && ws?.connected === true
    this.lastPullTickWsGeneration = generation

    if (
      sameSocketSinceLastTick &&
      Date.now() - this.lastPullTickPullAt < PERIODIC_PULL_MAX_QUIET_MS
    ) {
      log.debug('Periodic pull skipped: socket continuously connected since last tick')
      return
    }

    this.lastPullTickPullAt = Date.now()
    this.pullCoordinator.periodicPull(() => this.pullOutsideFullSync())
  }

  // Last-resort watchdog. Request timeouts make a hung HTTP call settle on its
  // own; this covers a lock leaked by any other never-settling await. Forcing
  // the release risks a brief overlap if the zombie sync later resumes —
  // accepted over sync staying dead until restart.
  private recoverStaleSyncLock(): void {
    if (!this.ctx.syncing || this.syncLockAcquiredAt === null) return
    const heldForMs = Date.now() - this.syncLockAcquiredAt
    if (heldForMs < SYNC_LOCK_STALE_MS) return

    log.error('Sync lock held past stale threshold — force releasing', { heldForMs })
    this.ctx.abortController?.abort()
    this.ctx.fullSyncActive = false
    this.ctx.inFlightSync = null
    // An abandoned push must not hold the socket fast path off (#2300).
    this.pushCoordinator.resetPushInFlight()
    // A wake pull chained behind the abandoned sync may never run.
    this.pendingWakeCursor = null
    this.activeLockRelease?.()
    this.releaseLock()
  }

  private releaseLock(): void {
    this.ctx.syncing = false
    this.ctx.abortController = null
    this.syncLockAcquiredAt = null
    this.activeLockRelease = null
    if (this.ctx.state === 'syncing') {
      this.stateManager.setState(this.ctx.deps.network.online ? 'idle' : 'offline')
    }
    this.pushCoordinator.onSyncCycleEnded()
  }

  private async reconnectSync(offlineDurationMs: number): Promise<void> {
    if (offlineDurationMs > STALE_CURSOR_THRESHOLD_MS) {
      log.info('Extended offline detected, resetting cursor for full re-pull', {
        offlineHours: Math.round(offlineDurationMs / 3_600_000)
      })
      this.stateManager.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    }
    await this.fullSync()
  }

  // --- Error recovery (delegated) ---

  private async handleCoordinatorError(error: unknown): Promise<void> {
    await this.errorRecovery.handleCoordinatorError(error)
  }

  private handleDeviceRevoked(): void {
    this.errorRecovery.handleDeviceRevoked()
  }

  // --- Event handlers ---

  private handleNetworkChange = ({ online }: { online: boolean }): void => {
    if (online) {
      this.networkReconnectAbortController?.abort()
      const reconnectAbortController = new AbortController()
      this.networkReconnectAbortController = reconnectAbortController

      void (async () => {
        const isStaleReconnectAttempt = (): boolean =>
          reconnectAbortController.signal.aborted ||
          this.networkReconnectAbortController !== reconnectAbortController ||
          !this.ctx.deps.network.online

        if (!(await this.isAuthReady()) || isStaleReconnectAttempt()) return

        if (this.ctx.abortController && this.ctx.syncing) {
          log.info('Network restored: aborting in-flight sync to run fullSync')
          this.ctx.abortController.abort()
        }

        if (this.ctx.inFlightSync) {
          await this.ctx.inFlightSync.catch(() => {})
        }
        if (isStaleReconnectAttempt()) return

        const offlineDurationMs = this.ctx.offlineSince ? Date.now() - this.ctx.offlineSince : 0
        if (isStaleReconnectAttempt()) return
        this.stateManager.setState('idle')
        void this.ctx.deps.ws.connect()

        this.armPeriodicPull()

        if (!this.stateManager.isPaused()) {
          this.scheduleSync(() => this.reconnectSync(offlineDurationMs))
        }
      })().finally(() => {
        if (this.networkReconnectAbortController === reconnectAbortController) {
          this.networkReconnectAbortController = null
        }
      })
    } else {
      this.networkReconnectAbortController?.abort()
      this.networkReconnectAbortController = null

      if (this.pullInterval) {
        clearInterval(this.pullInterval)
        this.pullInterval = null
      }
      if (this.ctx.abortController && this.ctx.syncing) {
        log.info('Network lost: aborting in-flight sync')
        this.ctx.abortController.abort()
      }
      this.stateManager.setState('offline')
      this.ctx.deps.ws.disconnect()
    }
  }

  private handleDeviceRevokedFromWs = (): void => {
    this.handleDeviceRevoked()
  }

  private handleCertPinFailed = (event: CertificatePinFailedEvent): void => {
    this.errorRecovery.handleCertPinFailed(event)
  }

  private handleWsMessage = (message: Exclude<SyncSocketEvent, { kind: 'ignored' }>): void => {
    switch (message.kind) {
      case 'changes_available':
        if (this.stateManager.isPaused()) break
        // Socket items (#2300) are latency only and never awaited. The wake
        // pull below still runs, unconditionally: it owns LAST_CURSOR and every
        // failure policy, and it delivers whatever the fast path dropped.
        if (message.items) void this.socketApply.apply(message)
        this.scheduleWakePull(message.cursor)
        break
      case 'crdt_updated': {
        const { noteId } = message
        if (!this.ctx.deps.crdtProvider || this.stateManager.isPaused()) break
        // A wake once the legacy sweep is done and the frame carries a cursor
        // (#2421): the feed serves every body row above LAST_CURSOR, and the
        // cursor is only the #2290 skip filter, never a pull cursor. Before
        // `done`, or from a server that sends no cursor (before #2420), the
        // feed may not serve this body, so the note keeps its durable
        // per-note pull.
        if (
          message.cursor !== undefined &&
          this.stateManager.getStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP) ===
            NOTE_BODY_LEGACY_SWEEP_DONE
        ) {
          // Unmerged until the feed passes the cursor, so no snapshot push
          // prunes the write just announced (#2421, 07 §7.13.2).
          const woken = this.wakeCursorByNote.get(noteId) ?? -Infinity
          this.wakeCursorByNote.set(noteId, Math.max(woken, message.cursor))
          this.scheduleWakePull(message.cursor)
          break
        }
        if (this.ctx.fullSyncActive) {
          this.crdtSync.queuePulls([noteId], 'broadcast')
        } else {
          // Marked before the pull is even scheduled. The broadcast is the
          // server telling us a peer's state for this note is not in our doc,
          // and `scheduleSync` may not run the callback for a while — that
          // whole span is time in which the 30s snapshot scheduler would
          // otherwise push a snapshot and prune the very update we were just
          // told about. A clean pull clears it.
          this.crdtSync.markRemoteStateUnmerged(noteId)
          // The merged/failed answer is the replay's concern; a broadcast-driven
          // pull that fails is already owed a retry by the coordinator.
          this.scheduleSync(async () => {
            await this.crdtSync.pullCrdtForNote(noteId)
          })
        }
        break
      }
      case 'calendar_changes_available':
        this.ctx.deps.calendarSyncOneSource?.(message.sourceId)
        break
      case 'auth_ok':
        log.debug('WS auth refreshed', { exp: message.exp })
        break
      case 'error':
        if (message.code === 'AUTH_DEVICE_REVOKED') {
          this.handleDeviceRevoked()
        } else {
          log.warn('Server-sent WS error', { code: message.code, message: message.message })
        }
        break
      case 'linking_request':
        this.ctx.deps.emitToRenderer(EVENT_CHANNELS.LINKING_REQUEST, {
          sessionId: message.sessionId,
          newDeviceName: message.newDeviceName,
          newDevicePlatform: message.newDevicePlatform
        } satisfies LinkingRequestEvent)
        break
      case 'linking_approved':
        this.ctx.deps.emitToRenderer(EVENT_CHANNELS.LINKING_APPROVED, {
          sessionId: message.sessionId
        } satisfies LinkingApprovedEvent)
        break
    }
  }

  // A reconnect pulls the feed, which re-serves every body row above
  // LAST_CURSOR (#2421); it re-pulls no note by itself.
  private handleWsConnected = (): void => {
    if (this.stateManager.isPaused()) return
    // Refused by a running full sync, whose pull may have read the feed
    // before the socket came back: its `finally` pulls again.
    if (!this.scheduleSync(() => this.pullOutsideFullSync())) this.raiseWakeCursor(Infinity)
  }
}
