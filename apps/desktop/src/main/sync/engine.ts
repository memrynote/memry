import { EventEmitter } from 'events'
import { createSyncAdapterRegistry } from '@memry/sync-core'
import { createLogger } from '../lib/logger'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import type { CertificatePinFailedEvent, QuarantinedItemInfo } from '@memry/contracts/ipc-events'
import type { GetSyncStatusResult, PauseSyncResult, ResumeSyncResult, SyncStatusValue } from '@memry/contracts/ipc-sync-ops'
import type { QueueStats } from './queue'
import type { WebSocketMessage } from './websocket'
import { secureCleanup } from '../crypto/index'
import { getFromServer } from './http-client'
import { classifyError } from './sync-errors'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { ItemApplier } from './apply-item'
import { FullSyncRunner } from './engine/full-sync-runner'
import type { SyncContext, SyncEngineDeps, SyncEngineOptions } from './engine/sync-context'
import { PUSH_BATCH_SIZE, PULL_PAGE_LIMIT, STALE_CURSOR_THRESHOLD_MS, SYNC_STATE_KEYS } from './engine/sync-context'
import { SyncStateManager } from './engine/sync-state-manager'
import { QuarantineManager } from './engine/quarantine-manager'
import { CrdtSyncCoordinator } from './engine/crdt-sync-coordinator'
import { PushCoordinator } from './engine/push-coordinator'
import { PullCoordinator } from './engine/pull-coordinator'
import { ErrorRecoveryHandler } from './engine/error-recovery-handler'
import { trackMainEvent } from '../telemetry/track'

export type { SyncEngineDeps, SyncEngineOptions }

const log = createLogger('SyncEngine')

const MAX_SYNC_ENGINE_LISTENERS = 50

const classifySyncErrorCode = (error: unknown): string => {
  try {
    const info = classifyError(error)
    return info?.category ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

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

    this.stateManager = new SyncStateManager(this.ctx, (event, ...args) => this.emit(event, ...args))
    this.quarantine = new QuarantineManager(this.ctx)
    this.pullCoordinator = new PullCoordinator(
      this.ctx,
      this.stateManager,
      this.quarantine,
      null as unknown as CrdtSyncCoordinator,
      null as unknown as PushCoordinator
    )
    this.crdtSync = new CrdtSyncCoordinator(this.ctx, (id) => this.pullCoordinator.resolveDeviceKey(id))
    this.pushCoordinator = new PushCoordinator(this.ctx, this.stateManager)

    // Wire up the circular dependencies now that all collaborators exist ;(
    ;(this.pullCoordinator as unknown as { crdtSync: CrdtSyncCoordinator }).crdtSync = this.crdtSync
    ;(this.pullCoordinator as unknown as { pushCoordinator: PushCoordinator }).pushCoordinator = this.pushCoordinator

    this.errorRecovery = new ErrorRecoveryHandler(this.ctx, this.stateManager, () => this.scheduleSync(() => this.fullSync()))

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
    const [token, signingKeys] = await Pro

    // ... (rest of the code remains the same)

  }

  // ... (rest of the code remains the same)

  private async push(): Promise<void> {
    // ... (rest of the code remains the same)

    // Update LAST_CURSOR to max(LAST_CURSOR, server_returned_cursor - 1)
    const lastCursor = await this.stateManager.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)
    const newCursor = Math.max(lastCursor, serverReturnedCursor - 1)
    await this.stateManager.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, newCursor.toString())

    // ... (rest of the code remains the same)
  }
}
