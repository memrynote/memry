import { SyncEventEmitter } from '@memry/sync-client/emitter'
import { createSyncAdapterRegistry } from '@memry/sync-core'
import { createLogger } from '../lib/logger'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import type { CertificatePinFailedEvent, QuarantinedItemInfo } from '@memry/contracts/ipc-events'
import type {
  GetSyncStatusResult,
  PauseSyncResult,
  ResumeSyncResult,
  SyncStatusValue
} from '@memry/contracts/ipc-sync-ops'
import type { QueueStats } from '@memry/sync-client/queue'
import type { WebSocketMessage } from './websocket'
import { secureCleanup } from '../crypto/index'
import { getFromServer } from './http-client'
import { classifyError } from './sync-errors'
import { syncErrorTelemetryFor } from './sync-error-telemetry'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { ItemApplier } from './apply-item'
import { FullSyncRunner } from './engine/full-sync-runner'
import type { SyncContext, SyncEngineDeps, SyncEngineOptions } from './engine/sync-context'
import {
  PUSH_BATCH_SIZE,
  PULL_PAGE_LIMIT,
  STALE_CURSOR_THRESHOLD_MS,
  SYNC_STATE_KEYS
} from './engine/sync-context'
import { SyncStateManager } from './engine/sync-state-manager'
import { QuarantineManager } from './engine/quarantine-manager'
import { CrdtSyncCoordinator } from './engine/crdt-sync-coordinator'
import { PushCoordinator } from './engine/push-coordinator'
import { PullCoordinator } from './engine/pull-coordinator'
import { ErrorRecoveryHandler } from './engine/error-recovery-handler'
import { trackMainEvent } from '../telemetry/track'

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

// How often a WebSocket reconnect may re-pull the CRDT docs the provider still
// caches without an editor attached (up to inactiveDocLimit, currently 32).
//
// They cannot be dropped from reconnect recovery: a body-only remote edit
// reaches this device as a `crdt_updated` broadcast and by no other route —
// note records in the change feed carry no body — so an edit made while the
// socket was down is discovered either here or by the vault-wide sweep at the
// end of the next fullSync, and a socket-only reconnect does not run a
// fullSync. They also cannot run on every reconnect: backoff caps at 30s
// (websocket.ts), so a flapping connection buys a snapshot GET, paged
// incrementals and a vault-key derivation per cached doc twice a minute, for as
// long as the network misbehaves.
//
// 5 minutes therefore bounds the flapping case to roughly one cache pass per
// five minutes instead of ten, while costing nothing on a healthy connection —
// a stable socket delivers every edit live, and docs with a live editor stay on
// the every-reconnect path regardless. A pass suppressed inside the window is
// remembered and paid by the next reconnect or the periodic pull tick, so the
// worst case is an editor-less doc going stale for a few extra minutes during
// an outage, never a body that is not pulled at all.
export const INACTIVE_CRDT_SWEEP_MIN_INTERVAL_MS = 5 * 60 * 1000

// Floor between two pulls issued by the 60s tick while the socket has been
// continuously up.
//
// The tick's pull exists to heal a `changes_available` broadcast that never
// arrived. When the same socket is still connected as at the previous tick
// (`connectionGeneration` unchanged, `connected` true) no broadcast could have
// been missed: the socket pings every 25s and terminates itself after 31s of
// silence, so a half-open connection reports disconnected long before a tick
// would trust it. The pull is then a guaranteed-empty request, once a minute,
// per device, for the life of the app — and the same reasoning already decides
// the reconnect CRDT sweep in full-sync-runner.ts.
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
  // Zero means "never swept by this engine", so the first reconnect after a
  // start, vault switch or engine rebuild always sweeps. Instance state only:
  // a timestamp from a previous process says nothing about this socket.
  private lastInactiveCrdtSweepAt = 0
  private inactiveCrdtSweepOwed = false
  // The socket generation the previous pull tick observed, and when the tick
  // last actually pulled. Both are instance state re-armed with the interval —
  // see armPeriodicPull.
  private lastPullTickWsGeneration: number | null = null
  private lastPullTickPullAt = 0

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
    this.crdtSync = new CrdtSyncCoordinator(this.ctx, (id) =>
      this.pullCoordinator.resolveDeviceKey(id)
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
      (itemId, itemType) => this.quarantine.isQuarantined(itemId, itemType)
    )
    // Wired after the runner exists, for the same reason the coordinators above
    // are: the coordinator raises the debt and the runner is what persists it,
    // and neither can be constructed holding the other.
    this.crdtSync.onUnmergedDebtChange = (hasDebt) =>
      this.fullSyncRunner.recordCrdtUnmergedDebt(hasDebt)
    this.ctx.doPush = () => this.push()
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
    this.pushCoordinator.clearDebounce()
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
   * `CrdtSyncCoordinator.hasUnmergedRemoteState`.
   *
   * It is also `true` for every note while this session cannot yet name them:
   * the per-note set does not survive a quit, so a session that starts after one
   * that ended holding debt has to answer for the whole vault until a sweep
   * rebuilds the flags. See `FullSyncRunner.crdtUnmergedStateUnknown`.
   */
  hasUnmergedRemoteCrdtState(noteId: string): boolean {
    return (
      this.fullSyncRunner.crdtUnmergedStateUnknown || this.crdtSync.hasUnmergedRemoteState(noteId)
    )
  }

  async fullSync(options: { forceCrdtSweep?: boolean } = {}): Promise<void> {
    const start = Date.now()
    try {
      await this.fullSyncRunner.run(options)
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
    return this.quarantine.getQuarantinedItems()
  }

  // --- Internal orchestration ---

  private syncLock: Promise<void> = Promise.resolve()

  private scheduleSync(fn: () => Promise<void>): void {
    if (this.ctx.fullSyncActive) return
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
    // Both of these are in-process watchdogs with no network cost, and both
    // must keep running every tick regardless of what the socket is doing.
    this.recoverStaleSyncLock()
    this.payOwedInactiveCrdtSweep()

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
    this.pullCoordinator.periodicPull()
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

  private handleWsMessage = (message: WebSocketMessage): void => {
    switch (message.type) {
      case 'changes_available':
        if (!this.stateManager.isPaused()) {
          this.scheduleSync(async () => {
            await this.pull()
          })
        }
        break
      case 'crdt_updated': {
        const noteId = message.payload?.noteId as string | undefined
        if (!noteId || !this.ctx.deps.crdtProvider || this.stateManager.isPaused()) break
        if (this.ctx.fullSyncActive) {
          this.crdtSync.addPendingPull(noteId)
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
      case 'calendar_changes_available': {
        const sourceId = message.payload?.sourceId
        if (typeof sourceId === 'string' && sourceId.length > 0) {
          this.ctx.deps.calendarSyncOneSource?.(sourceId)
        } else {
          log.debug('calendar_changes_available message missing sourceId', {
            payload: message.payload
          })
        }
        break
      }
      case 'heartbeat':
        break
      case 'auth_ok':
        log.debug('WS auth refreshed', { exp: message.payload?.exp })
        break
      case 'error':
        if (message.payload?.code === 'AUTH_DEVICE_REVOKED') {
          this.handleDeviceRevoked()
        } else {
          log.warn('Server-sent WS error', { payload: message.payload })
        }
        break
      case 'linking_request':
        this.ctx.deps.emitToRenderer(EVENT_CHANNELS.LINKING_REQUEST, message.payload)
        break
      case 'linking_approved':
        this.ctx.deps.emitToRenderer(EVENT_CHANNELS.LINKING_APPROVED, message.payload)
        break
      default:
        log.debug('Unknown WS message type', { type: (message as { type: string }).type })
    }
  }

  private handleWsConnected = (): void => {
    if (!this.stateManager.isPaused()) {
      this.scheduleSync(async () => {
        await this.pull()

        // Docs with a live editor are what the user is looking at right now:
        // pulled on every reconnect, however often the socket flaps.
        const activeNoteIds = this.ctx.deps.crdtProvider?.getOpenNoteIds({ active: true }) ?? []
        for (const noteId of activeNoteIds) {
          await this.crdtSync.pullCrdtForNote(noteId)
        }

        await this.sweepInactiveCrdtDocs()
      })
    }
  }

  /**
   * Re-pull the cached CRDT docs no editor holds open, at most once per
   * INACTIVE_CRDT_SWEEP_MIN_INTERVAL_MS. A pass the window suppresses is
   * remembered rather than dropped — see the constant for why neither dropping
   * it nor running it every reconnect is acceptable.
   */
  private async sweepInactiveCrdtDocs(): Promise<void> {
    const crdtProvider = this.ctx.deps.crdtProvider
    if (!crdtProvider) return

    if (Date.now() - this.lastInactiveCrdtSweepAt < INACTIVE_CRDT_SWEEP_MIN_INTERVAL_MS) {
      this.inactiveCrdtSweepOwed = true
      return
    }

    this.lastInactiveCrdtSweepAt = Date.now()
    this.inactiveCrdtSweepOwed = false

    // Re-read both sets here rather than reusing the reconnect's snapshot: an
    // editor may have opened or closed while the active pulls above ran.
    const activeNoteIds = new Set(crdtProvider.getOpenNoteIds({ active: true }))
    for (const noteId of crdtProvider.getOpenNoteIds()) {
      if (activeNoteIds.has(noteId)) continue
      await this.crdtSync.pullCrdtForNote(noteId)
    }
  }

  /**
   * Settles a sweep the window held back when no further reconnect arrives to
   * carry it — a socket that flaps twice and then stabilises still owes one.
   * Paused or mid-fullSync it stays owed: resume() and fullSync both end in the
   * vault-wide CRDT sweep, and the flag survives for the next tick regardless.
   */
  private payOwedInactiveCrdtSweep(): void {
    if (!this.inactiveCrdtSweepOwed || this.stateManager.isPaused()) return
    if (Date.now() - this.lastInactiveCrdtSweepAt < INACTIVE_CRDT_SWEEP_MIN_INTERVAL_MS) return
    this.scheduleSync(() => this.sweepInactiveCrdtDocs())
  }
}
