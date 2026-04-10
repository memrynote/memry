import { EventEmitter } from 'events'
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
import type { QueueStats } from './queue'
import type { WebSocketMessage } from './websocket'
import { secureCleanup } from '../crypto/index'
import { getFromServer } from './http-client'
import { classifyError } from './sync-errors'
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

export type { SyncEngineDeps, SyncEngineOptions }

const log = createLogger('SyncEngine')
const MAX_SYNC_ENGINE_LISTENERS = 50

export class SyncEngine extends EventEmitter {
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
      }
    )
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
      if (!this.stateManager.isPaused()) {
        await this.fullSync()
      }
      this.pullInterval = setInterval(() => this.pullCoordinator.periodicPull(), 60_000)
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
    this.pullCoordinator.clearCaches()
    this.quarantine.clear()
    this.ctx.syncing = false
    this.stateManager.setState('idle')
    SyncEngine.activeInstance = null
  }

  // --- Public sync operations (delegated) ---

  async push(): Promise<void> {
    try {
      await this.pushCoordinator.push()
    } catch (error) {
      await this.handleCoordinatorError(error)
    }
  }

  async pull(): Promise<void> {
    try {
      await this.pullCoordinator.pull()
    } catch (error) {
      await this.handleCoordinatorError(error)
    }
  }

  requestPush(): void {
    this.pushCoordinator.requestPush()
  }

  async fullSync(): Promise<void> {
    await this.fullSyncRunner.run()
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
    if (this.ctx.syncing || this.stateManager.isPaused()) return null
    this.ctx.syncing = true

    let release!: () => void
    const prev = this.syncLock
    this.syncLock = new Promise((r) => {
      release = r
    })
    await prev
    return release
  }

  private releaseLock(): void {
    this.ctx.syncing = false
    this.ctx.abortController = null
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

        if (!this.pullInterval) {
          this.pullInterval = setInterval(() => this.pullCoordinator.periodicPull(), 60_000)
        }

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
          this.scheduleSync(() => this.pull())
        }
        break
      case 'crdt_updated': {
        const noteId = message.payload?.noteId as string | undefined
        if (!noteId || !this.ctx.deps.crdtProvider || this.stateManager.isPaused()) break
        if (this.ctx.fullSyncActive) {
          this.crdtSync.addPendingPull(noteId)
        } else {
          this.scheduleSync(() => this.crdtSync.pullCrdtForNote(noteId))
        }
        break
      }
      case 'heartbeat':
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

        const openNoteIds = this.ctx.deps.crdtProvider?.getOpenNoteIds() ?? []
        for (const noteId of openNoteIds) {
          await this.crdtSync.pullCrdtForNote(noteId)
        }
      })
    }
  }
}
