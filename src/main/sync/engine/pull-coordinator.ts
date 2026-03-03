import { createLogger } from '../../lib/logger'
import { EVENT_CHANNELS } from '@shared/contracts/ipc-events'
import type {
  ConflictDetectedEvent,
  InitialSyncProgressEvent,
  ItemRecoveredEvent,
  ItemCorruptEvent
} from '@shared/contracts/ipc-events'
import type { ChangesResponse, PullItemResponse, SyncItemType } from '@shared/contracts/sync-api'
import { PullResponseSchema } from '@shared/contracts/sync-api'
import { secureCleanup } from '../../crypto/index'
import { decryptPullBatch } from '../sync-crypto-batch'
import { getHandler } from '../item-handlers'
import { withRetry } from '../retry'
import { postToServer, getFromServer, RateLimitError } from '../http-client'
import { classifyError } from '../sync-errors'
import { isBinaryFileType } from '@shared/file-types'
import { SyncTimer } from '../sync-timer'
import type { SyncContext } from './sync-context'
import type { SyncStateManager } from './sync-state-manager'
import type { QuarantineManager } from './quarantine-manager'
import type { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import type { PushCoordinator } from './push-coordinator'
import { CorruptItemTracker } from './corrupt-item-tracker'
import { SYNC_STATE_KEYS, YIELD_EVERY_N_ITEMS, yieldToEventLoop } from './sync-context'

const log = createLogger('PullCoordinator')

interface PullRunState {
  timer: SyncTimer
  startTime: number
  pulledCount: number
  totalConflictsResolved: number
  processedIds: Set<string>
  crdtNoteIds: string[]
  token: string
  vaultKey: Uint8Array
}

export class PullCoordinator {
  private ctx: SyncContext
  private stateManager: SyncStateManager
  private quarantine: QuarantineManager
  private crdtSync: CrdtSyncCoordinator
  private pushCoordinator: PushCoordinator
  private corruptTracker: CorruptItemTracker
  private deviceKeyCache = new Map<string, Uint8Array | null>()

  constructor(
    ctx: SyncContext,
    stateManager: SyncStateManager,
    quarantine: QuarantineManager,
    crdtSync: CrdtSyncCoordinator,
    pushCoordinator: PushCoordinator
  ) {
    this.ctx = ctx
    this.stateManager = stateManager
    this.quarantine = quarantine
    this.crdtSync = crdtSync
    this.pushCoordinator = pushCoordinator
    this.corruptTracker = new CorruptItemTracker(ctx, quarantine, (id) => this.resolveDeviceKey(id))
  }

  async pull(): Promise<void> {
    const release = await this.ctx.acquireLock()
    if (!release) return

    const cleanup = this.createPullCleanup(release)
    let vaultKey: Uint8Array | null = null
    this.deviceKeyCache.clear()

    try {
      const pullStartedAt = Date.now()
      this.stateManager.setState('syncing')
      this.ctx.abortController = new AbortController()

      const credentials = await this.getPullCredentials()
      if (!credentials) return
      vaultKey = credentials.vaultKey

      const runState = this.createPullRunState(
        credentials.token,
        credentials.vaultKey,
        pullStartedAt
      )
      try {
        await this.pullChanges(runState)
        this.finalizePullSuccess(runState)
      } catch (error) {
        this.handlePullError(error, runState.startTime)
      }
    } finally {
      this.cleanupAfterPull(vaultKey, cleanup)
    }
  }

  periodicPull(): void {
    if (
      this.ctx.syncing ||
      this.ctx.fullSyncActive ||
      this.stateManager.isPaused() ||
      !this.ctx.deps.network.online
    ) {
      log.debug('Periodic pull skipped', {
        syncing: this.ctx.syncing,
        fullSyncActive: this.ctx.fullSyncActive,
        paused: this.stateManager.isPaused(),
        online: this.ctx.deps.network.online
      })
      return
    }
    this.ctx.scheduleSync(() => this.pull())
  }

  async resolveDeviceKey(deviceId: string): Promise<Uint8Array | null> {
    if (this.deviceKeyCache.has(deviceId)) {
      return this.deviceKeyCache.get(deviceId)!
    }
    const key = await this.ctx.deps.getDevicePublicKey(deviceId)
    this.deviceKeyCache.set(deviceId, key)
    return key
  }

  clearCaches(): void {
    this.deviceKeyCache.clear()
    this.corruptTracker.clear()
  }

  private createPullCleanup(release: () => void): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.ctx.releaseLock()
      release()
    }
  }

  private async getPullCredentials(): Promise<{ token: string; vaultKey: Uint8Array } | null> {
    const token = await this.ctx.deps.getAccessToken()
    if (!token) return null

    const vaultKey = await this.ctx.deps.getVaultKey()
    if (!vaultKey) return null

    return { token, vaultKey }
  }

  private createPullRunState(token: string, vaultKey: Uint8Array, startTime: number): PullRunState {
    return {
      timer: new SyncTimer(),
      startTime,
      pulledCount: 0,
      totalConflictsResolved: 0,
      processedIds: new Set<string>(),
      crdtNoteIds: [],
      token,
      vaultKey
    }
  }

  private async pullChanges(runState: PullRunState): Promise<void> {
    let cursor = this.stateManager.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)
    let hasMore = true

    type ChangesRetryResult = Awaited<ReturnType<typeof this.fetchChangesPage>>
    let changesResult: ChangesRetryResult
    let prefetchedNext: Promise<ChangesRetryResult> | null = null

    while (hasMore) {
      if (this.ctx.abortController!.signal.aborted) break

      if (prefetchedNext) {
        changesResult = await prefetchedNext
        prefetchedNext = null
      } else {
        changesResult = await this.fetchChangesPage(runState.token, cursor)
      }

      const changes = changesResult.value
      const shouldStop = await this.pullChangesPage(changes, runState)
      this.emitInitialSyncProgress(changes, runState.pulledCount)

      this.stateManager.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, String(changes.nextCursor))
      cursor = String(changes.nextCursor)
      hasMore = changes.hasMore

      if (shouldStop) break

      if (hasMore && !this.ctx.abortController?.signal.aborted) {
        prefetchedNext = this.fetchChangesPage(runState.token, cursor)
        prefetchedNext.catch(() => {})
      }
    }
  }

  private async fetchChangesPage(
    token: string,
    pageCursor: string | null | undefined
  ): ReturnType<typeof withRetry<ChangesResponse>> {
    return withRetry(
      () => {
        const cp = pageCursor ? `&cursor=${pageCursor}` : ''
        return getFromServer<ChangesResponse>(
          `/sync/changes?limit=${this.ctx.options.pullPageLimit}${cp}`,
          token
        )
      },
      {
        signal: this.ctx.abortController!.signal,
        isOnline: () => this.ctx.deps.network.online
      }
    )
  }

  private async pullChangesPage(
    changes: ChangesResponse,
    runState: PullRunState
  ): Promise<boolean> {
    const itemIds = Array.from(
      new Set([...changes.items.map((item) => item.id), ...changes.deleted])
    )
    if (itemIds.length === 0) return false

    const pageResult = await this.processPage(
      itemIds,
      runState.token,
      runState.vaultKey,
      runState.timer,
      runState.processedIds,
      runState.crdtNoteIds
    )
    runState.pulledCount += pageResult.applied
    runState.totalConflictsResolved += pageResult.conflicts
    await this.applyCrdtBatch(runState)

    return pageResult.allCryptoFailed
  }

  private async applyCrdtBatch(runState: PullRunState): Promise<void> {
    if (runState.crdtNoteIds.length === 0 || !this.ctx.deps.crdtProvider) return

    runState.timer.startPhase('crdt-batch')
    await this.crdtSync.applyCrdtBatch(runState.crdtNoteIds, runState.token, runState.vaultKey)
    runState.timer.endPhase(runState.crdtNoteIds.length)
    runState.crdtNoteIds.length = 0
  }

  private emitInitialSyncProgress(changes: ChangesResponse, pulledCount: number): void {
    if (!this.ctx.fullSyncActive) return

    const estimatedTotal = changes.hasMore
      ? pulledCount + this.ctx.options.pullPageLimit
      : pulledCount
    this.ctx.deps.emitToRenderer(EVENT_CHANNELS.INITIAL_SYNC_PROGRESS, {
      phase: 'notes',
      processedItems: pulledCount,
      totalItems: estimatedTotal
    } satisfies InitialSyncProgressEvent)
  }

  private finalizePullSuccess(runState: PullRunState): void {
    log.info('Pull timing', runState.timer.finish())
    this.stateManager.recordHistory('pull', runState.pulledCount, Date.now() - runState.startTime)
    this.stateManager.updateLastSyncAt()
    this.ctx.rateLimitConsecutive = 0

    if (runState.totalConflictsResolved > 0) {
      log.info('Pull: re-enqueued merged items for push-back', {
        conflicts: runState.totalConflictsResolved
      })
      this.ctx.requestPush()
    }
  }

  private handlePullError(error: unknown, startedAt: number): void {
    if (error instanceof DOMException && error.name === 'AbortError') {
      log.debug('Pull aborted (likely network change)')
      return
    }

    const errorInfo = classifyError(error)
    this.ctx.lastErrorInfo = errorInfo
    this.ctx.lastError = errorInfo.message
    if (
      errorInfo.category === 'device_revoked' ||
      errorInfo.category === 'auth_expired' ||
      errorInfo.category === 'network_offline' ||
      error instanceof RateLimitError
    ) {
      throw error
    }

    this.stateManager.setState('error')
    this.stateManager.recordHistory('error', 0, Date.now() - startedAt, errorInfo.message)
  }

  private cleanupAfterPull(vaultKey: Uint8Array | null, cleanup: () => void): void {
    this.deviceKeyCache.clear()
    try {
      if (vaultKey) secureCleanup(vaultKey)
    } finally {
      cleanup()
    }
  }

  private async processPage(
    itemIds: string[],
    token: string,
    vaultKey: Uint8Array,
    timer: SyncTimer,
    processedIds: Set<string>,
    crdtNoteIds: string[]
  ): Promise<{ applied: number; conflicts: number; allCryptoFailed: boolean }> {
    const pullResult = await withRetry(
      () => postToServer<{ items: PullItemResponse[] }>('/sync/pull', { itemIds }, token),
      { signal: this.ctx.abortController!.signal, isOnline: () => this.ctx.deps.network.online }
    )

    const parsed = PullResponseSchema.safeParse(pullResult.value)
    if (!parsed.success) {
      log.error('Invalid pull response from server', { error: parsed.error.message })
      return { applied: 0, conflicts: 0, allCryptoFailed: false }
    }

    log.debug('Pull: response parsed', {
      requestedCount: itemIds.length,
      receivedCount: parsed.data.items.length
    })

    const signerIds = new Set(parsed.data.items.map((i) => i.signerDeviceId))
    await Promise.all(Array.from(signerIds).map((sid) => this.resolveDeviceKey(sid)))
    log.debug('Pull: device keys prefetched', { signerCount: signerIds.size })

    let pageApplied = 0
    let pageSkipped = 0
    let pageFailed = 0
    let cryptoFailCount = 0
    let pageConflicts = 0

    const itemsToProcess = parsed.data.items.filter((item) => {
      if (processedIds.has(item.id)) {
        pageSkipped++
        return false
      }
      if (this.quarantine.isQuarantined(item.id)) {
        pageSkipped++
        return false
      }
      return true
    })

    timer.startPhase('encrypt')
    const { decrypted, failures } = await decryptPullBatch(itemsToProcess, vaultKey, {
      workerBridge: this.ctx.deps.workerBridge,
      resolveDeviceKey: (id) => this.resolveDeviceKey(id)
    })
    timer.endPhase(itemsToProcess.length)

    for (const failure of failures) {
      if (failure.isSignatureError) {
        this.quarantine.quarantineItem(
          failure.id,
          failure.type,
          failure.signerDeviceId,
          failure.error
        )
        pageFailed++
        continue
      }
      log.error('Pull: failed to process item', {
        itemId: failure.id,
        type: failure.type,
        signerDeviceId: failure.signerDeviceId,
        isCryptoError: failure.isCryptoError,
        error: failure.error
      })
      pageFailed++
      if (failure.isCryptoError) cryptoFailCount++
    }

    const parseErrorIds: Array<{ id: string; type: string }> = []

    timer.startPhase('apply')
    this.pushCoordinator.suppressPushDuringPull = true
    try {
      for (let i = 0; i < decrypted.length; i++) {
        if (this.ctx.abortController?.signal.aborted) break
        if (i > 0 && i % YIELD_EVERY_N_ITEMS === 0) await yieldToEventLoop()
        const dec = decrypted[i]
        try {
          const contentBytes = new TextEncoder().encode(dec.content)
          const itemOp = dec.deletedAt ? 'delete' : (dec.operation as 'create' | 'update')
          const result = this.ctx.applier.apply({
            itemId: dec.id,
            type: dec.type as Parameters<typeof this.ctx.applier.apply>[0]['type'],
            operation: itemOp,
            content: contentBytes,
            clock: dec.clock,
            deletedAt: dec.deletedAt
          })

          if (result === 'parse_error') {
            parseErrorIds.push({ id: dec.id, type: dec.type })
            pageFailed++
            continue
          }

          if (result === 'conflict') {
            this.handleConflict(dec)
            pageConflicts++
          }

          if (
            (dec.type === 'note' || dec.type === 'journal') &&
            this.ctx.deps.crdtProvider &&
            itemOp !== 'delete'
          ) {
            let isBinary = false
            try {
              const p = JSON.parse(dec.content) as { fileType?: string }
              if (p.fileType && isBinaryFileType(p.fileType)) isBinary = true
            } catch {
              /* safe to skip CRDT on parse failure */
            }
            if (!isBinary) crdtNoteIds.push(dec.id)
          }

          processedIds.add(dec.id)
          pageApplied++
          this.stateManager.emitItemSynced(dec.id, dec.type, 'pull', itemOp)
        } catch (applyError) {
          log.error('Pull: failed to apply decrypted item', {
            itemId: dec.id,
            type: dec.type,
            error: applyError instanceof Error ? applyError.message : String(applyError)
          })
          pageFailed++
        }
      }
    } finally {
      this.pushCoordinator.suppressPushDuringPull = false
    }
    timer.endPhase(decrypted.length)

    const cryptoRefetchIds = failures.filter((f) => f.isCryptoError).map((f) => f.id)
    const parseRefetchIds = parseErrorIds.map((p) => p.id)
    const allRefetchIds = [...cryptoRefetchIds, ...parseRefetchIds]

    if (allRefetchIds.length > 0 && pageApplied > 0) {
      this.corruptTracker.clearExpired()
      const { recovered, permanentFailures } = await this.corruptTracker.refetch(
        allRefetchIds,
        token,
        vaultKey
      )

      for (const dec of recovered) {
        try {
          const contentBytes = new TextEncoder().encode(dec.content)
          const itemOp = dec.deletedAt ? 'delete' : (dec.operation as 'create' | 'update')
          const result = this.ctx.applier.apply({
            itemId: dec.id,
            type: dec.type as Parameters<typeof this.ctx.applier.apply>[0]['type'],
            operation: itemOp,
            content: contentBytes,
            clock: dec.clock,
            deletedAt: dec.deletedAt
          })
          if (result === 'applied' || result === 'conflict') {
            processedIds.add(dec.id)
            pageApplied++
            pageFailed--
            this.stateManager.emitItemSynced(dec.id, dec.type, 'pull', itemOp)
            this.ctx.deps.emitToRenderer(EVENT_CHANNELS.ITEM_RECOVERED, {
              itemId: dec.id,
              type: dec.type
            } satisfies ItemRecoveredEvent)
            log.info('Pull: recovered corrupt item', { itemId: dec.id, type: dec.type })
          }
        } catch (err) {
          log.error('Pull: failed to apply recovered item', {
            itemId: dec.id,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }

      for (const id of permanentFailures) {
        const failInfo = parseErrorIds.find((p) => p.id === id) ?? failures.find((f) => f.id === id)
        this.ctx.deps.emitToRenderer(EVENT_CHANNELS.ITEM_CORRUPT, {
          itemId: id,
          type: failInfo?.type ?? 'unknown',
          error: 'Item corrupt after re-fetch attempt'
        } satisfies ItemCorruptEvent)
      }

      if (recovered.length > 0 || permanentFailures.length > 0) {
        log.info('Pull: re-fetch summary', {
          recovered: recovered.length,
          permanentFailures: permanentFailures.length
        })
      }
    }

    log.info('Pull page processed', {
      total: parsed.data.items.length,
      applied: pageApplied,
      skipped: pageSkipped,
      failed: pageFailed,
      conflicts: pageConflicts
    })

    let allCryptoFailed = false
    if (
      pageFailed > 0 &&
      pageFailed === cryptoFailCount &&
      parsed.data.items.length > 0 &&
      pageApplied === 0
    ) {
      this.ctx.lastError =
        'All items failed with crypto errors — possible vault key mismatch. ' +
        `${cryptoFailCount} item(s) could not be decrypted.`
      this.ctx.lastErrorInfo = {
        category: 'crypto_failure',
        message: this.ctx.lastError,
        retryable: false
      }
      this.stateManager.setState('error')
      log.error('Pull: circuit breaker tripped — all items failed crypto', { cryptoFailCount })
      allCryptoFailed = true
    }

    return { applied: pageApplied, conflicts: pageConflicts, allCryptoFailed }
  }

  private handleConflict(dec: {
    id: string
    type: string
    content: string
    clock?: Record<string, number>
  }): void {
    let remoteVersion: Record<string, unknown> = {}
    try {
      const parsedRemote = JSON.parse(dec.content) as unknown
      if (parsedRemote && typeof parsedRemote === 'object' && !Array.isArray(parsedRemote)) {
        remoteVersion = parsedRemote as Record<string, unknown>
      }
      if (dec.clock) remoteVersion.clock = dec.clock
    } catch {
      log.warn('Failed to parse remote content for conflict event', { itemId: dec.id })
    }

    const localVersion = this.fetchLocalItem(dec.id, dec.type)

    this.ctx.deps.emitToRenderer(EVENT_CHANNELS.CONFLICT_DETECTED, {
      itemId: dec.id,
      type: dec.type,
      localVersion,
      remoteVersion,
      localClock: (localVersion.clock as Record<string, number>) ?? undefined,
      remoteClock: dec.clock ?? undefined
    } satisfies ConflictDetectedEvent)

    this.ctx.deps.queue.enqueue({
      type: dec.type as SyncItemType,
      itemId: dec.id,
      operation: 'update',
      payload: '{}'
    })
  }

  private fetchLocalItem(itemId: string, type: string): Record<string, unknown> {
    try {
      const handler = getHandler(type as SyncItemType)
      if (!handler) return {}
      return handler.fetchLocal(this.ctx.deps.db, itemId) ?? {}
    } catch {
      log.warn('Failed to fetch local item for conflict', { itemId, type })
      return {}
    }
  }
}
