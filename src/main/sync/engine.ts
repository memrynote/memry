import { EventEmitter } from 'events'
import { createLogger } from '../lib/logger'
import { eq } from 'drizzle-orm'
import { syncState } from '@shared/db/schema/sync-state'
import { syncHistory } from '@shared/db/schema/sync-history'
import { EVENT_CHANNELS } from '@shared/contracts/ipc-events'
import type {
  SyncStatusChangedEvent,
  ItemSyncedEvent,
  SyncPausedEvent,
  SyncResumedEvent,
  ConflictDetectedEvent,
  QueueClearedEvent,
  ClockSkewWarningEvent,
  InitialSyncProgressEvent,
  ItemRecoveredEvent,
  ItemCorruptEvent,
  DeviceRevokedEvent
} from '@shared/contracts/ipc-events'
import type {
  GetSyncStatusResult,
  PauseSyncResult,
  ResumeSyncResult,
  SyncStatusValue
} from '@shared/contracts/ipc-sync-ops'
import type {
  ChangesResponse,
  PushResponse,
  PullItemResponse,
  SyncItemType
} from '@shared/contracts/sync-api'
import { PullResponseSchema } from '@shared/contracts/sync-api'
import { SyncQueueManager, ERROR_RETENTION_DAYS, type QueueStats } from './queue'
import { NetworkMonitor } from './network'
import { WebSocketManager, type WebSocketMessage } from './websocket'
import { secureCleanup } from '../crypto/index'
import { encryptPushBatch, decryptPullBatch } from './sync-crypto-batch'
import type { SyncWorkerBridge } from './worker-bridge'
import { ItemApplier } from './apply-item'
import { getHandler, type DrizzleDb } from './item-handlers'
import { withRetry } from './retry'
import {
  postToServer,
  getFromServer,
  fetchCrdtSnapshot,
  type CrdtBatchPullResponse
} from './http-client'
import { classifyError, type SyncErrorInfo } from './sync-errors'
import { isBinaryFileType } from '@shared/file-types'
import { checkManifestIntegrity } from './manifest-check'
import { runInitialSeed } from './initial-seed'
import type { CrdtProvider } from './crdt-provider'
import { decryptCrdtUpdate } from './crdt-encrypt'
import { parallelWithLimit } from './concurrency'
import { SyncTimer } from './sync-timer'

const log = createLogger('SyncEngine')

const YIELD_EVERY_N_ITEMS = 20
const CRDT_SNAPSHOT_CONCURRENCY = 5
const yieldToEventLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

const PUSH_BATCH_SIZE = 100
const MAX_PUSH_ITERATIONS = 50
const CLOCK_SKEW_THRESHOLD_SECONDS = 300
const PULL_PAGE_LIMIT = 100
const CORRUPT_ITEM_COOLDOWN_MS = 60 * 60 * 1000
const SYNC_STATE_KEYS = {
  LAST_CURSOR: 'lastCursor',
  LAST_SYNC_AT: 'lastSyncAt',
  SYNC_PAUSED: 'syncPaused',
  INITIAL_SEED_DONE: 'initialSeedDone'
} as const

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
  crdtProvider?: CrdtProvider
  workerBridge?: SyncWorkerBridge
  refreshAccessToken?: () => Promise<boolean>
}

export interface SyncEngineOptions {
  pushBatchSize: number
  pullPageLimit: number
}

export class SyncEngine extends EventEmitter {
  private static activeInstance: SyncEngine | null = null

  private state: SyncStatusValue = 'idle'
  private syncLock: Promise<void> = Promise.resolve()
  private syncing = false
  private fullSyncActive = false
  private lastManifestCheckAt = 0
  private lastError: string | undefined
  private lastErrorInfo: SyncErrorInfo | undefined
  private deps: SyncEngineDeps
  private options: SyncEngineOptions
  private abortController: AbortController | null = null
  private inFlightSync: Promise<void> | null = null
  private pushDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private pullInterval: ReturnType<typeof setInterval> | null = null
  private pendingPushRequested = false
  private readonly PUSH_DEBOUNCE_MS = 2000
  private applier: ItemApplier
  private deviceKeyCache = new Map<string, Uint8Array | null>()
  private suppressPushDuringPull = false
  private pendingCrdtPulls = new Set<string>()
  private corruptItems = new Map<string, { failedAt: number; attempts: number }>()

  constructor(deps: SyncEngineDeps, options?: Partial<SyncEngineOptions>) {
    super()
    if (SyncEngine.activeInstance && SyncEngine.activeInstance.syncing) {
      throw new Error('SyncEngine instance already active — call stop() before creating a new one')
    }
    this.deps = deps
    this.options = {
      pushBatchSize: options?.pushBatchSize ?? PUSH_BATCH_SIZE,
      pullPageLimit: options?.pullPageLimit ?? PULL_PAGE_LIMIT
    }
    this.applier = new ItemApplier(deps.db, deps.emitToRenderer)
    SyncEngine.activeInstance = this
  }

  private async isAuthReady(): Promise<boolean> {
    const [token, signingKeys] = await Promise.all([
      this.deps.getAccessToken(),
      this.deps.getSigningKeys()
    ])
    return token !== null && signingKeys !== null
  }

  get currentState(): SyncStatusValue {
    return this.state
  }

  async start(): Promise<void> {
    this.deps.network.on('status-changed', this.handleNetworkChange)
    this.deps.ws.on('message', this.handleWsMessage)
    this.deps.ws.on('connected', this.handleWsConnected)
    this.deps.ws.on('device_revoked', this.handleDeviceRevokedFromWs)

    if (!(await this.isAuthReady())) {
      this.setState('idle')
      return
    }

    if (this.deps.network.online) {
      await this.deps.ws.connect()
      if (!this.isPaused()) {
        await this.fullSync()
      }
    } else {
      this.setState('offline')
    }

    this.pullInterval = setInterval(() => this.periodicPull(), 60_000)
  }

  async activate(): Promise<void> {
    if (this.syncing) return
    if (!(await this.isAuthReady())) return

    if (this.deps.network.online) {
      this.setState('idle')
      await this.deps.ws.connect()
      if (!this.isPaused()) {
        await this.fullSync()
      }
    }
  }

  async stop(options?: { skipFinalPush?: boolean }): Promise<void> {
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer)
      this.pushDebounceTimer = null
    }
    if (this.pullInterval) {
      clearInterval(this.pullInterval)
      this.pullInterval = null
    }
    this.pendingPushRequested = false

    this.abortController?.abort()
    if (this.inFlightSync) {
      await this.inFlightSync.catch(() => {})
    }
    this.abortController = null
    this.inFlightSync = null

    const skipPush =
      options?.skipFinalPush ||
      !this.deps.network.online ||
      this.lastErrorInfo?.category === 'device_revoked'

    if (!skipPush) {
      const pending = this.deps.queue.getPendingCount()
      if (pending > 0) {
        log.info(`Shutdown: attempting final push of ${pending} item(s)`)
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), 2000)
        this.abortController = ac
        try {
          await this.push()
        } catch {
          log.warn('Shutdown: final push failed (non-fatal)')
        }
        clearTimeout(timer)
        this.abortController = null
      }
    }

    const remaining = this.deps.queue.getPendingCount()
    if (remaining > 0) {
      log.warn(`Shutdown: ${remaining} sync item(s) deferred to next startup`)
    }

    this.deps.network.removeListener('status-changed', this.handleNetworkChange)
    this.deps.ws.removeListener('message', this.handleWsMessage)
    this.deps.ws.removeListener('connected', this.handleWsConnected)
    this.deps.ws.removeListener('device_revoked', this.handleDeviceRevokedFromWs)
    this.deps.ws.disconnect()
    this.deviceKeyCache.clear()
    this.corruptItems.clear()
    this.syncing = false
    this.setState('idle')
    SyncEngine.activeInstance = null
  }

  private shouldRetryCorruptItem(itemId: string): boolean {
    const entry = this.corruptItems.get(itemId)
    if (!entry) return true
    if (Date.now() - entry.failedAt > CORRUPT_ITEM_COOLDOWN_MS) {
      this.corruptItems.delete(itemId)
      return true
    }
    return false
  }

  private markCorruptItemFailed(itemId: string): void {
    const entry = this.corruptItems.get(itemId)
    if (entry) {
      entry.attempts++
      entry.failedAt = Date.now()
    } else {
      this.corruptItems.set(itemId, { failedAt: Date.now(), attempts: 1 })
    }
  }

  private clearExpiredCorruptItems(): void {
    const now = Date.now()
    for (const [id, entry] of this.corruptItems) {
      if (now - entry.failedAt > CORRUPT_ITEM_COOLDOWN_MS) {
        this.corruptItems.delete(id)
      }
    }
  }

  private async refetchCorruptItems(
    failedItemIds: string[],
    token: string,
    vaultKey: Uint8Array
  ): Promise<{
    recovered: Array<{
      id: string
      type: string
      content: string
      clock?: Record<string, number>
      deletedAt?: number
      operation: string
    }>
    permanentFailures: string[]
  }> {
    const eligible = failedItemIds.filter((id) => this.shouldRetryCorruptItem(id))
    if (eligible.length === 0) return { recovered: [], permanentFailures: [] }

    log.info('Attempting re-fetch for corrupt items', { count: eligible.length })

    try {
      const pullResult = await withRetry(
        () =>
          postToServer<{ items: PullItemResponse[] }>('/sync/pull', { itemIds: eligible }, token),
        {
          signal: this.abortController?.signal ?? undefined,
          isOnline: () => this.deps.network.online
        }
      )

      const parsed = PullResponseSchema.safeParse(pullResult.value)
      if (!parsed.success) {
        log.error('Re-fetch: invalid response', { error: parsed.error.message })
        for (const id of eligible) this.markCorruptItemFailed(id)
        return { recovered: [], permanentFailures: eligible }
      }

      const signerIds = new Set(parsed.data.items.map((i) => i.signerDeviceId))
      for (const sid of signerIds) {
        await this.resolveDeviceKey(sid)
      }

      const { decrypted, failures } = await decryptPullBatch(parsed.data.items, vaultKey, {
        workerBridge: this.deps.workerBridge,
        resolveDeviceKey: (id) => this.resolveDeviceKey(id)
      })

      const permanentFailures: string[] = []
      for (const failure of failures) {
        this.markCorruptItemFailed(failure.id)
        permanentFailures.push(failure.id)
        log.warn('Re-fetch: item failed again', { itemId: failure.id, error: failure.error })
      }

      return { recovered: decrypted, permanentFailures }
    } catch (error) {
      log.error('Re-fetch request failed', {
        error: error instanceof Error ? error.message : String(error)
      })
      for (const id of eligible) this.markCorruptItemFailed(id)
      return { recovered: [], permanentFailures: eligible }
    }
  }

  private periodicPull(): void {
    if (this.syncing || this.fullSyncActive || this.isPaused() || !this.deps.network.online) {
      log.debug('Periodic pull skipped', {
        syncing: this.syncing,
        fullSyncActive: this.fullSyncActive,
        paused: this.isPaused(),
        online: this.deps.network.online
      })
      return
    }
    this.scheduleSync(() => this.pull())
  }

  async push(): Promise<void> {
    const pendingCount = this.deps.queue.getPendingCount()
    log.debug('Push entered', {
      queuePending: pendingCount,
      queueTotal: this.deps.queue.getSize(),
      syncing: this.syncing,
      fullSyncActive: this.fullSyncActive
    })

    if (pendingCount === 0) {
      log.debug('Push skipped: queue empty')
      return
    }

    const release = await this.acquireSyncLock()
    if (!release) {
      log.debug('Push skipped', { syncing: this.syncing, paused: this.isPaused() })
      return
    }
    this.setState('syncing')
    this.abortController = new AbortController()

    const token = await this.deps.getAccessToken()
    if (!token) {
      log.debug('Push aborted: no access token')
      this.releaseLock()
      release()
      return
    }

    const signingKeys = await this.deps.getSigningKeys()
    if (!signingKeys) {
      log.debug('Push aborted: no signing keys')
      this.releaseLock()
      release()
      return
    }

    const vaultKey = await this.deps.getVaultKey()
    if (!vaultKey) {
      log.debug('Push aborted: no vault key')
      this.releaseLock()
      release()
      return
    }

    const timer = new SyncTimer()
    const startTime = Date.now()
    let pushedCount = 0
    let lastServerTime = 0
    let lastMaxCursor = 0

    try {
      for (let iteration = 0; iteration < MAX_PUSH_ITERATIONS; iteration++) {
        if (this.abortController.signal.aborted) break

        const preDequeueCount = this.deps.queue.getPendingCount()
        const rawCount = this.deps.queue.getRawPendingCount()
        if (preDequeueCount !== rawCount) {
          log.error('Push: Drizzle vs raw SQL mismatch!', {
            drizzle: preDequeueCount,
            raw: rawCount
          })
        }
        const items = this.deps.queue.dequeue(this.options.pushBatchSize)
        if (items.length === 0) {
          log.debug('Push complete: queue empty', { preDequeueCount, rawCount })
          break
        }

        const dedupedItems = this.deduplicateByItemId(items)

        if (this.deps.crdtProvider) {
          const snapshotTasks = dedupedItems
            .filter((item) => {
              if (item.operation !== 'create') return false
              if (item.type !== 'note' && item.type !== 'journal') return false
              try {
                const parsed = JSON.parse(item.payload) as { fileType?: string }
                if (parsed.fileType && isBinaryFileType(parsed.fileType)) return false
              } catch {
                /* no payload parse = assume text, let snapshot push decide */
              }
              return true
            })
            .map((item) => () => this.deps.crdtProvider!.pushSnapshotForNote(item.itemId))
          if (snapshotTasks.length > 0) {
            const snapshotResults = await parallelWithLimit(
              snapshotTasks,
              CRDT_SNAPSHOT_CONCURRENCY,
              this.abortController.signal
            )
            const failedSnapshots = snapshotResults.filter((r) => r.status === 'rejected')
            if (failedSnapshots.length > 0) {
              log.warn('Push: some CRDT snapshots failed', { count: failedSnapshots.length })
            }
          }
        }

        timer.startPhase('encrypt')
        const pushItems = await encryptPushBatch(
          dedupedItems,
          vaultKey,
          signingKeys.secretKey,
          signingKeys.deviceId,
          {
            workerBridge: this.deps.workerBridge,
            queue: this.deps.queue,
            extractPayloadMetadata: (p) => this.extractPayloadMetadata(p),
            resolvePushPayload: (item, deviceId) => this.resolvePushPayload(item, deviceId)
          }
        )
        timer.endPhase(dedupedItems.length)

        timer.startPhase('network')
        const response = await withRetry(
          () =>
            postToServer<PushResponse>(
              '/sync/push',
              { items: pushItems.map((p) => p.pushItem) },
              token
            ),
          { signal: this.abortController.signal, isOnline: () => this.deps.network.online }
        )
        timer.endPhase()

        log.info('Push: server response', {
          iteration,
          accepted: response.value.accepted.length,
          rejected: response.value.rejected.length,
          serverTime: response.value.serverTime
        })

        lastServerTime = response.value.serverTime
        if (response.value.maxCursor > lastMaxCursor) {
          lastMaxCursor = response.value.maxCursor
        }
        const acceptedSet = new Set(response.value.accepted)
        for (let pi = 0; pi < pushItems.length; pi++) {
          if (this.abortController?.signal.aborted) break
          if (pi > 0 && pi % YIELD_EVERY_N_ITEMS === 0) await yieldToEventLoop()
          const { queueId, pushItem } = pushItems[pi]
          if (acceptedSet.has(pushItem.id)) {
            this.deps.queue.markSuccess(queueId)
            this.markItemSynced(pushItem.id, pushItem.type as SyncItemType)
            pushedCount++
            this.emitItemSynced(pushItem.id, pushItem.type, 'push')
          } else {
            const rejection = response.value.rejected.find((r) => r.id === pushItem.id)
            const reason = rejection?.reason ?? 'Unknown rejection'
            if (reason === 'SYNC_REPLAY_DETECTED') {
              log.info('Push: replay detected, server already has this or newer', {
                queueId: queueId.slice(0, 8),
                itemId: pushItem.id.slice(0, 8)
              })
              this.deps.queue.markSuccess(queueId)
              this.markItemSynced(pushItem.id, pushItem.type as SyncItemType)
            } else if (reason === 'STORAGE_QUOTA_EXCEEDED') {
              log.warn('Push: storage quota exceeded', { itemId: pushItem.id.slice(0, 8) })
              this.deps.queue.markFailed(queueId, reason)
              this.lastErrorInfo = {
                category: 'storage_quota_exceeded',
                message: 'Storage quota exceeded',
                retryable: false
              }
              this.lastError = 'Storage quota exceeded'
              this.setState('error')
              break
            } else {
              log.warn('Push: item rejected', {
                queueId: queueId.slice(0, 8),
                itemId: pushItem.id.slice(0, 8),
                reason
              })
              this.deps.queue.markFailed(queueId, reason)
            }
          }
        }
      }

      log.info('Push timing', timer.finish())

      if (pushedCount > 0) {
        this.recordHistory('push', pushedCount, Date.now() - startTime)
        this.updateLastSyncAt()
        if (lastServerTime > 0) this.checkClockSkew(lastServerTime)

        if (lastMaxCursor > 0) {
          const currentCursor = Number(this.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR) ?? '0')
          if (lastMaxCursor > currentCursor) {
            this.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, String(lastMaxCursor))
            log.debug('Push: advanced pull cursor', { from: currentCursor, to: lastMaxCursor })
          }
        }

        if (this.deps.queue.getPendingCount() === 0) {
          this.deps.emitToRenderer(EVENT_CHANNELS.QUEUE_CLEARED, {
            itemCount: pushedCount,
            duration: Date.now() - startTime
          } satisfies QueueClearedEvent)
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        log.debug('Push aborted (likely network change)')
        return
      }
      const errorInfo = classifyError(error)
      if (errorInfo.category === 'device_revoked') {
        this.handleDeviceRevoked()
        return
      }
      if (errorInfo.category === 'auth_expired') {
        await this.handleAuthExpired()
        return
      }
      this.lastErrorInfo = errorInfo
      this.lastError = errorInfo.message
      this.setState('error')
      this.recordHistory('error', 0, Date.now() - startTime, errorInfo.message)
    } finally {
      secureCleanup(vaultKey, signingKeys.secretKey)
      this.releaseLock()
      release()
    }
  }

  requestPush(): void {
    if (this.isPaused() || this.suppressPushDuringPull) return
    this.pendingPushRequested = true
    if (!this.deps.network.online) return
    if (this.pushDebounceTimer) return

    this.pushDebounceTimer = setTimeout(() => {
      this.pushDebounceTimer = null
      if (this.isPaused()) {
        this.pendingPushRequested = false
        return
      }
      if (this.syncing || this.fullSyncActive) {
        this.requestPush()
        return
      }
      if (this.pendingPushRequested) {
        this.pendingPushRequested = false
        this.scheduleSync(() => this.push())
      }
    }, this.PUSH_DEBOUNCE_MS)
  }

  async pull(): Promise<void> {
    const release = await this.acquireSyncLock()
    if (!release) return
    this.setState('syncing')
    this.abortController = new AbortController()

    const token = await this.deps.getAccessToken()
    if (!token) {
      this.releaseLock()
      release()
      return
    }

    const vaultKey = await this.deps.getVaultKey()
    if (!vaultKey) {
      this.releaseLock()
      release()
      return
    }
    const timer = new SyncTimer()
    const startTime = Date.now()
    let pulledCount = 0
    const processedIds = new Set<string>()
    const crdtNoteIds: string[] = []
    this.deviceKeyCache.clear()

    let totalConflictsResolved = 0

    try {
      let cursor = this.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)
      let hasMore = true

      const fetchChangesPage = (pageCursor: string | null | undefined) =>
        withRetry(
          () => {
            const cp = pageCursor ? `&cursor=${pageCursor}` : ''
            return getFromServer<ChangesResponse>(
              `/sync/changes?limit=${this.options.pullPageLimit}${cp}`,
              token
            )
          },
          { signal: this.abortController!.signal, isOnline: () => this.deps.network.online }
        )

      type ChangesRetryResult = Awaited<ReturnType<typeof fetchChangesPage>>
      let changesResult: ChangesRetryResult
      let prefetchedNext: Promise<ChangesRetryResult> | null = null

      while (hasMore) {
        if (this.abortController.signal.aborted) break

        if (prefetchedNext) {
          changesResult = await prefetchedNext
          prefetchedNext = null
        } else {
          changesResult = await fetchChangesPage(cursor)
        }

        const changes = changesResult.value

        const itemIds = Array.from(
          new Set([...changes.items.map((item) => item.id), ...changes.deleted])
        )
        if (itemIds.length > 0) {
          const pullResult = await withRetry(
            () => postToServer<{ items: PullItemResponse[] }>('/sync/pull', { itemIds }, token),
            { signal: this.abortController.signal, isOnline: () => this.deps.network.online }
          )

          const parsed = PullResponseSchema.safeParse(pullResult.value)
          if (!parsed.success) {
            log.error('Invalid pull response from server', { error: parsed.error.message })
            break
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
              log.debug('Skipping duplicate item in pull', { itemId: item.id })
              pageSkipped++
              return false
            }
            return true
          })

          timer.startPhase('encrypt')
          const { decrypted, failures } = await decryptPullBatch(itemsToProcess, vaultKey, {
            workerBridge: this.deps.workerBridge,
            resolveDeviceKey: (id) => this.resolveDeviceKey(id)
          })
          timer.endPhase(itemsToProcess.length)

          for (const failure of failures) {
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
          this.suppressPushDuringPull = true
          try {
            for (let i = 0; i < decrypted.length; i++) {
              if (this.abortController?.signal.aborted) break
              if (i > 0 && i % YIELD_EVERY_N_ITEMS === 0) await yieldToEventLoop()
              const dec = decrypted[i]
              try {
                const contentBytes = new TextEncoder().encode(dec.content)
                const itemOp = dec.deletedAt ? 'delete' : (dec.operation as 'create' | 'update')
                const result = this.applier.apply({
                  itemId: dec.id,
                  type: dec.type as Parameters<ItemApplier['apply']>[0]['type'],
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
                  let remoteVersion: Record<string, unknown> = {}
                  try {
                    const parsedRemote = JSON.parse(dec.content) as unknown
                    if (
                      parsedRemote &&
                      typeof parsedRemote === 'object' &&
                      !Array.isArray(parsedRemote)
                    ) {
                      remoteVersion = parsedRemote as Record<string, unknown>
                    }
                    if (dec.clock) remoteVersion.clock = dec.clock
                  } catch {
                    log.warn('Failed to parse remote content for conflict event', {
                      itemId: dec.id
                    })
                  }

                  const localVersion = this.fetchLocalItem(dec.id, dec.type)

                  this.deps.emitToRenderer(EVENT_CHANNELS.CONFLICT_DETECTED, {
                    itemId: dec.id,
                    type: dec.type,
                    localVersion,
                    remoteVersion,
                    localClock: (localVersion.clock as Record<string, number>) ?? undefined,
                    remoteClock: dec.clock ?? undefined
                  } satisfies ConflictDetectedEvent)

                  this.deps.queue.enqueue({
                    type: dec.type as SyncItemType,
                    itemId: dec.id,
                    operation: 'update',
                    payload: '{}'
                  })
                  pageConflicts++
                }

                if (
                  (dec.type === 'note' || dec.type === 'journal') &&
                  this.deps.crdtProvider &&
                  itemOp !== 'delete'
                ) {
                  let isBinary = false
                  try {
                    const parsed = JSON.parse(dec.content) as { fileType?: string }
                    if (parsed.fileType && isBinaryFileType(parsed.fileType)) isBinary = true
                  } catch {
                    /* content already applied by handler; safe to skip CRDT on parse failure */
                  }
                  if (!isBinary) crdtNoteIds.push(dec.id)
                }

                processedIds.add(dec.id)
                pulledCount++
                pageApplied++
                this.emitItemSynced(dec.id, dec.type, 'pull', itemOp)
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
            this.suppressPushDuringPull = false
          }
          timer.endPhase(decrypted.length)

          if (crdtNoteIds.length > 0 && this.deps.crdtProvider) {
            timer.startPhase('crdt-batch')
            await this.applyCrdtBatch(crdtNoteIds, token, vaultKey)
            timer.endPhase(crdtNoteIds.length)
            crdtNoteIds.length = 0
          }

          const cryptoRefetchIds = failures.filter((f) => f.isCryptoError).map((f) => f.id)
          const parseRefetchIds = parseErrorIds.map((p) => p.id)
          const allRefetchIds = [...cryptoRefetchIds, ...parseRefetchIds]

          const hasNonCryptoSuccesses = pageApplied > 0
          if (allRefetchIds.length > 0 && hasNonCryptoSuccesses) {
            this.clearExpiredCorruptItems()
            const { recovered, permanentFailures } = await this.refetchCorruptItems(
              allRefetchIds,
              token,
              vaultKey
            )

            for (const dec of recovered) {
              try {
                const contentBytes = new TextEncoder().encode(dec.content)
                const itemOp = dec.deletedAt ? 'delete' : (dec.operation as 'create' | 'update')
                const result = this.applier.apply({
                  itemId: dec.id,
                  type: dec.type as Parameters<ItemApplier['apply']>[0]['type'],
                  operation: itemOp,
                  content: contentBytes,
                  clock: dec.clock,
                  deletedAt: dec.deletedAt
                })

                if (result === 'applied' || result === 'conflict') {
                  processedIds.add(dec.id)
                  pulledCount++
                  pageApplied++
                  pageFailed--
                  this.emitItemSynced(dec.id, dec.type, 'pull', itemOp)
                  this.deps.emitToRenderer(EVENT_CHANNELS.ITEM_RECOVERED, {
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
              const failInfo =
                parseErrorIds.find((p) => p.id === id) ?? failures.find((f) => f.id === id)
              this.deps.emitToRenderer(EVENT_CHANNELS.ITEM_CORRUPT, {
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

          totalConflictsResolved += pageConflicts

          log.info('Pull page processed', {
            total: parsed.data.items.length,
            applied: pageApplied,
            skipped: pageSkipped,
            failed: pageFailed,
            conflicts: pageConflicts
          })

          if (
            pageFailed > 0 &&
            pageFailed === cryptoFailCount &&
            parsed.data.items.length > 0 &&
            pageApplied === 0
          ) {
            this.lastError =
              'All items failed with crypto errors — possible vault key mismatch. ' +
              `${cryptoFailCount} item(s) could not be decrypted.`
            this.lastErrorInfo = {
              category: 'crypto_failure',
              message: this.lastError,
              retryable: false
            }
            this.setState('error')
            log.error('Pull: circuit breaker tripped — all items failed crypto', {
              cryptoFailCount
            })
            break
          }
        }

        if (this.fullSyncActive) {
          const estimatedTotal = changes.hasMore
            ? pulledCount + this.options.pullPageLimit
            : pulledCount
          this.deps.emitToRenderer(EVENT_CHANNELS.INITIAL_SYNC_PROGRESS, {
            phase: 'notes',
            processedItems: pulledCount,
            totalItems: estimatedTotal
          } satisfies InitialSyncProgressEvent)
        }

        this.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, String(changes.nextCursor))
        cursor = String(changes.nextCursor)
        hasMore = changes.hasMore

        if (hasMore && !this.abortController?.signal.aborted) {
          prefetchedNext = fetchChangesPage(cursor)
          prefetchedNext.catch(() => {})
        }
      }

      log.info('Pull timing', timer.finish())

      this.recordHistory('pull', pulledCount, Date.now() - startTime)
      this.updateLastSyncAt()

      if (totalConflictsResolved > 0) {
        log.info('Pull: re-enqueued merged items for push-back', {
          conflicts: totalConflictsResolved
        })
        this.requestPush()
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        log.debug('Pull aborted (likely network change)')
        return
      }
      const errorInfo = classifyError(error)
      if (errorInfo.category === 'device_revoked') {
        this.handleDeviceRevoked()
        return
      }
      if (errorInfo.category === 'auth_expired') {
        await this.handleAuthExpired()
        return
      }
      this.lastErrorInfo = errorInfo
      this.lastError = errorInfo.message
      this.setState('error')
      this.recordHistory('error', 0, Date.now() - startTime, errorInfo.message)
    } finally {
      this.deviceKeyCache.clear()
      secureCleanup(vaultKey)
      this.releaseLock()
      release()
    }
  }

  async fullSync(): Promise<void> {
    log.debug('fullSync started')
    this.fullSyncActive = true
    try {
      await this.pull()
      log.debug('fullSync: pull complete')

      const queueBeforeSeed = this.deps.queue.getPendingCount()
      const signingKeys = await this.deps.getSigningKeys()
      if (signingKeys) {
        runInitialSeed({ db: this.deps.db, queue: this.deps.queue, deviceId: signingKeys.deviceId })
      }
      const queueAfterSeed = this.deps.queue.getPendingCount()
      const seededCount = Math.max(0, queueAfterSeed - queueBeforeSeed)

      log.debug('fullSync: seed complete', {
        attempted: signingKeys ? 'yes' : 'skipped',
        seededCount
      })

      if (queueAfterSeed > 0) {
        this.deps.emitToRenderer(EVENT_CHANNELS.INITIAL_SYNC_PROGRESS, {
          phase: 'tasks',
          processedItems: 0,
          totalItems: queueAfterSeed
        } satisfies InitialSyncProgressEvent)
      }

      await this.push()
      log.debug('fullSync: push complete')

      this.deps.emitToRenderer(EVENT_CHANNELS.INITIAL_SYNC_PROGRESS, {
        phase: 'manifest',
        processedItems: 0,
        totalItems: 0
      } satisfies InitialSyncProgressEvent)

      const manifestResult = await checkManifestIntegrity({
        db: this.deps.db,
        queue: this.deps.queue,
        getAccessToken: this.deps.getAccessToken,
        isOnline: () => this.deps.network.online,
        lastCheckAt: this.lastManifestCheckAt
      })
      this.lastManifestCheckAt = manifestResult.checkedAt
      log.debug('fullSync: manifest check complete', {
        rePullNeeded: manifestResult.rePullNeeded,
        serverOnlyCount: manifestResult.serverOnlyCount
      })

      if (manifestResult.rePullNeeded) {
        log.info('fullSync: manifest detected server-only items, resetting cursor for re-pull', {
          serverOnlyCount: manifestResult.serverOnlyCount
        })
        this.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
        await this.pull()
        log.debug('fullSync: re-pull complete')
      }

      this.pendingPushRequested = false
      if (this.pushDebounceTimer) {
        clearTimeout(this.pushDebounceTimer)
        this.pushDebounceTimer = null
      }

      const pendingAfterManifest = this.deps.queue.getPendingCount()
      if (pendingAfterManifest > 0 && !this.isPaused()) {
        log.debug('fullSync: pending items after manifest check, running follow-up push', {
          pendingAfterManifest
        })
        await this.push()
        log.debug('fullSync: follow-up push complete')
      }

      this.deps.queue.purgeOldErrors(
        new Date(Date.now() - ERROR_RETENTION_DAYS * 24 * 60 * 60 * 1000)
      )

      this.deps.emitToRenderer(EVENT_CHANNELS.INITIAL_SYNC_PROGRESS, {
        phase: 'complete',
        processedItems: 0,
        totalItems: 0
      } satisfies InitialSyncProgressEvent)
    } finally {
      this.fullSyncActive = false
      if (this.pendingCrdtPulls.size > 0) {
        log.debug('fullSync: flushing pending CRDT pulls', {
          count: this.pendingCrdtPulls.size
        })
        for (const noteId of this.pendingCrdtPulls) {
          this.scheduleSync(() => this.pullCrdtForNote(noteId))
        }
        this.pendingCrdtPulls.clear()
      }
    }
  }

  getStatus(): GetSyncStatusResult {
    return {
      status: this.state,
      lastSyncAt: this.getLastSyncAt(),
      pendingCount: this.deps.queue.getPendingCount(),
      error: this.lastError,
      errorCategory: this.lastErrorInfo?.category
    }
  }

  getQueueStats(): QueueStats {
    return this.deps.queue.getQueueStats()
  }

  pause(): PauseSyncResult {
    const wasPaused = this.isPaused()
    this.setStateValue(SYNC_STATE_KEYS.SYNC_PAUSED, 'true')

    if (!wasPaused) {
      this.abortController?.abort()
      const pendingCount = this.deps.queue.getPendingCount()
      this.emitPaused(pendingCount)
    }

    return { success: true, wasPaused }
  }

  resume(): ResumeSyncResult {
    this.setStateValue(SYNC_STATE_KEYS.SYNC_PAUSED, 'false')
    const pendingCount = this.deps.queue.getPendingCount()
    this.emitResumed(pendingCount)

    if (this.deps.network.online) {
      this.scheduleSync(() => this.fullSync())
    }

    return { success: true, pendingCount }
  }

  private scheduleSync(fn: () => Promise<void>): void {
    if (this.fullSyncActive) return
    const run = () =>
      fn()
        .catch((error) => {
          log.error('Scheduled sync failed', error)
        })
        .finally(() => {
          this.inFlightSync = null
        })

    if (this.inFlightSync) {
      log.debug('scheduleSync: chaining onto in-flight sync')
      this.inFlightSync = this.inFlightSync.then(run)
    } else {
      this.inFlightSync = run()
    }
  }

  private handleNetworkChange = ({ online }: { online: boolean }): void => {
    if (online) {
      void (async () => {
        if (!(await this.isAuthReady())) return

        if (this.abortController && this.syncing) {
          log.info('Network restored: aborting in-flight sync to run fullSync')
          this.abortController.abort()
        }

        if (this.inFlightSync) {
          await this.inFlightSync.catch(() => {})
        }

        this.setState('idle')
        void this.deps.ws.connect()
        if (!this.isPaused()) {
          this.scheduleSync(() => this.fullSync())
        }
      })()
    } else {
      this.setState('offline')
      this.deps.ws.disconnect()
    }
  }

  private handleDeviceRevokedFromWs = (): void => {
    this.handleDeviceRevoked()
  }

  private handleWsMessage = (message: WebSocketMessage): void => {
    switch (message.type) {
      case 'changes_available':
        if (!this.isPaused()) {
          this.scheduleSync(() => this.pull())
        }
        break
      case 'crdt_updated': {
        const noteId = message.payload?.noteId as string | undefined
        log.warn('[DIAG] crdt_updated handler entered', {
          noteId,
          hasCrdtProvider: !!this.deps.crdtProvider,
          isPaused: this.isPaused(),
          fullSyncActive: this.fullSyncActive
        })
        if (!noteId || !this.deps.crdtProvider || this.isPaused()) {
          log.warn('[DIAG] crdt_updated dropped by guard')
          break
        }
        if (this.fullSyncActive) {
          log.warn('[DIAG] crdt_updated queued (fullSync active)', { noteId })
          this.pendingCrdtPulls.add(noteId)
        } else {
          log.warn('[DIAG] crdt_updated scheduling pull', { noteId })
          this.scheduleSync(() => this.pullCrdtForNote(noteId))
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
        this.deps.emitToRenderer(EVENT_CHANNELS.LINKING_REQUEST, message.payload)
        break
      case 'linking_approved':
        this.deps.emitToRenderer(EVENT_CHANNELS.LINKING_APPROVED, message.payload)
        break
      default:
        log.debug('Unknown WS message type', { type: (message as { type: string }).type })
    }
  }

  private handleWsConnected = (): void => {
    if (!this.isPaused()) {
      this.scheduleSync(() => this.pull())
    }
  }

  private async acquireSyncLock(): Promise<(() => void) | null> {
    if (this.syncing || this.isPaused()) return null
    this.syncing = true

    let release!: () => void
    const prev = this.syncLock
    this.syncLock = new Promise((r) => {
      release = r
    })
    await prev
    return release
  }

  private releaseLock(): void {
    this.syncing = false
    this.abortController = null
    if (this.state === 'syncing') {
      this.setState(this.deps.network.online ? 'idle' : 'offline')
    }
  }

  private async resolveDeviceKey(deviceId: string): Promise<Uint8Array | null> {
    if (this.deviceKeyCache.has(deviceId)) {
      return this.deviceKeyCache.get(deviceId)!
    }
    const key = await this.deps.getDevicePublicKey(deviceId)
    this.deviceKeyCache.set(deviceId, key)
    return key
  }

  private setState(newState: SyncStatusValue): void {
    if (this.state === newState) return
    this.state = newState
    if (newState !== 'error') {
      this.lastError = undefined
      this.lastErrorInfo = undefined
    }
    this.emitStatusChanged()
  }

  private async handleAuthExpired(): Promise<void> {
    if (!this.deps.refreshAccessToken) {
      this.lastErrorInfo = {
        category: 'auth_expired',
        message: 'Session expired',
        retryable: false
      }
      this.lastError = 'Session expired'
      this.setState('error')
      return
    }

    log.info('Auth expired during sync, attempting token refresh')
    const refreshed = await this.deps.refreshAccessToken()
    if (refreshed) {
      log.info('Token refreshed successfully, scheduling full sync')
      this.scheduleSync(() => this.fullSync())
    } else {
      this.lastErrorInfo = {
        category: 'auth_expired',
        message: 'Session expired',
        retryable: false
      }
      this.lastError = 'Session expired'
      this.setState('error')
    }
  }

  private handleDeviceRevoked(): void {
    log.warn('Device has been revoked by another device')

    this.abortController?.abort()

    this.lastErrorInfo = {
      category: 'device_revoked',
      message: 'This device has been removed',
      retryable: false
    }
    this.lastError = 'This device has been removed'
    this.setState('error')

    this.deps.ws.disconnect()

    const unsyncedCount = this.deps.queue.getPendingCount()
    this.deps.emitToRenderer(EVENT_CHANNELS.DEVICE_REMOVED, {
      unsyncedCount
    } satisfies DeviceRevokedEvent)
  }

  private isPaused(): boolean {
    return this.getStateValue(SYNC_STATE_KEYS.SYNC_PAUSED) === 'true'
  }

  private getStateValue(key: string): string | undefined {
    const rows = this.deps.db.select().from(syncState).where(eq(syncState.key, key)).all()
    return rows[0]?.value
  }

  private setStateValue(key: string, value: string): void {
    this.deps.db
      .insert(syncState)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: syncState.key,
        set: { value, updatedAt: new Date() }
      })
      .run()
  }

  private getLastSyncAt(): number | undefined {
    const val = this.getStateValue(SYNC_STATE_KEYS.LAST_SYNC_AT)
    return val ? parseInt(val, 10) : undefined
  }

  private updateLastSyncAt(): void {
    this.setStateValue(SYNC_STATE_KEYS.LAST_SYNC_AT, String(Date.now()))
  }

  private recordHistory(
    type: 'push' | 'pull' | 'error',
    itemCount: number,
    durationMs: number,
    details?: string
  ): void {
    this.deps.db
      .insert(syncHistory)
      .values({
        id: crypto.randomUUID(),
        type,
        itemCount,
        direction: type === 'error' ? undefined : type,
        durationMs,
        details: details ?? undefined,
        createdAt: new Date()
      })
      .run()
  }

  private emitStatusChanged(): void {
    const event: SyncStatusChangedEvent = {
      status: this.state,
      lastSyncAt: this.getLastSyncAt(),
      pendingCount: this.deps.queue.getPendingCount(),
      error: this.lastError,
      errorCategory: this.lastErrorInfo?.category
    }
    this.deps.emitToRenderer(EVENT_CHANNELS.STATUS_CHANGED, event)
    this.emit('status-changed', event)
  }

  private markItemSynced(itemId: string, type: SyncItemType): void {
    try {
      const handler = getHandler(type)
      handler?.markPushSynced?.(this.deps.db, itemId)
    } catch (err) {
      log.warn('Failed to mark item syncedAt after push', { itemId, type, error: err })
    }
  }

  private emitItemSynced(
    itemId: string,
    type: string,
    operation: 'push' | 'pull',
    itemOperation?: 'create' | 'update' | 'delete'
  ): void {
    const event: ItemSyncedEvent = { itemId, type, operation, itemOperation }
    this.deps.emitToRenderer(EVENT_CHANNELS.ITEM_SYNCED, event)
    this.emit('item-synced', event)
  }

  private emitPaused(pendingCount: number): void {
    const event: SyncPausedEvent = { pendingCount }
    this.deps.emitToRenderer(EVENT_CHANNELS.PAUSED, event)
    this.emit('paused', event)
  }

  private emitResumed(pendingCount: number): void {
    const event: SyncResumedEvent = { pendingCount }
    this.deps.emitToRenderer(EVENT_CHANNELS.RESUMED, event)
    this.emit('resumed', event)
  }

  // Timestamp convention: server uses Unix seconds, client uses Date.now() ms internally,
  // and ISO 8601 strings for DB columns (syncedAt, createdAt, modifiedAt).
  private checkClockSkew(serverTimeSeconds: number): void {
    const localTimeSeconds = Math.floor(Date.now() / 1000)
    const skew = Math.abs(localTimeSeconds - serverTimeSeconds)
    if (skew > CLOCK_SKEW_THRESHOLD_SECONDS) {
      log.error('Clock skew detected, pausing sync', {
        localTimeSeconds,
        serverTimeSeconds,
        skewSeconds: skew
      })
      this.deps.emitToRenderer(EVENT_CHANNELS.CLOCK_SKEW_WARNING, {
        localTime: localTimeSeconds,
        serverTime: serverTimeSeconds,
        skewSeconds: skew
      } satisfies ClockSkewWarningEvent)
      this.pause()
    }
  }

  private extractPayloadMetadata(payload: string): {
    clock?: Record<string, number>
    stateVector?: string
  } {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      const clockValue = parsed.clock
      const stateVectorValue = parsed.stateVector
      return {
        clock:
          clockValue && typeof clockValue === 'object' && !Array.isArray(clockValue)
            ? (clockValue as Record<string, number>)
            : undefined,
        stateVector: typeof stateVectorValue === 'string' ? stateVectorValue : undefined
      }
    } catch (err) {
      log.warn('Failed to parse payload metadata', { error: err })
      return {}
    }
  }

  private fetchLocalItem(itemId: string, type: string): Record<string, unknown> {
    try {
      const handler = getHandler(type as SyncItemType)
      if (!handler) return {}
      return handler.fetchLocal(this.deps.db, itemId) ?? {}
    } catch {
      log.warn('Failed to fetch local item for conflict', { itemId, type })
      return {}
    }
  }

  private deduplicateByItemId(
    items: Array<typeof import('@shared/db/schema/sync-queue').syncQueue.$inferSelect>
  ): typeof items {
    const seen = new Map<string, (typeof items)[0]>()
    const dupeIds: string[] = []

    for (const item of items) {
      const key = `${item.type}:${item.itemId}`
      if (!seen.has(key)) {
        seen.set(key, item)
      } else {
        dupeIds.push(item.id)
      }
    }

    if (dupeIds.length > 0) {
      log.info('Push: deduplicated queue items', { removed: dupeIds.length })
      for (const id of dupeIds) {
        this.deps.queue.markSuccess(id)
      }
    }

    return Array.from(seen.values())
  }

  private resolvePushPayload(
    item: { itemId: string; type: string; operation: string; payload: string },
    deviceId: string
  ): string {
    if (item.operation === 'delete') return item.payload

    try {
      const handler = getHandler(item.type as SyncItemType)
      if (!handler?.buildPushPayload) return item.payload

      const fresh = handler.buildPushPayload(this.deps.db, item.itemId, deviceId, item.operation)
      if (!fresh) {
        log.debug('Push: item no longer exists locally, using frozen payload', {
          itemId: item.itemId.slice(0, 8),
          type: item.type
        })
        return item.payload
      }

      return fresh
    } catch (err) {
      log.warn('Push: failed to build fresh payload, using frozen', {
        itemId: item.itemId.slice(0, 8),
        type: item.type,
        error: err
      })
      return item.payload
    }
  }

  private async applyCrdtIncrementals(
    noteId: string,
    token: string,
    vaultKey: Uint8Array,
    signal?: AbortSignal
  ): Promise<void> {
    if (!this.deps.crdtProvider) {
      log.warn('[DIAG] applyCrdtIncrementals: no crdtProvider', { noteId })
      return
    }

    const effectiveSignal = signal ?? this.abortController?.signal
    if (!effectiveSignal) {
      log.warn('[DIAG] applyCrdtIncrementals: no signal available', {
        noteId,
        hasPassedSignal: !!signal,
        hasAbortController: !!this.abortController
      })
      return
    }

    try {
      const doc = await this.deps.crdtProvider.open(noteId, undefined, { skipSeed: true })
      if (!doc) return

      let since = 0

      const stateVector = this.deps.crdtProvider.getStateVector(noteId)
      const needsBootstrap = !stateVector || stateVector.length <= 2

      if (needsBootstrap) {
        const snapshotResult = await fetchCrdtSnapshot(noteId, token)
        if (snapshotResult) {
          const signerPubKey = await this.resolveDeviceKey(snapshotResult.signerDeviceId)
          if (signerPubKey) {
            const decrypted = decryptCrdtUpdate(
              snapshotResult.snapshot,
              vaultKey,
              noteId,
              signerPubKey
            )
            this.deps.crdtProvider.applyRemoteUpdate(noteId, decrypted)
            since = snapshotResult.sequenceNum
            log.debug('Applied CRDT snapshot', { noteId, sequenceNum: since })
          } else {
            log.warn('Skipping CRDT snapshot from unresolvable signer', {
              noteId,
              signerDeviceId: snapshotResult.signerDeviceId
            })
          }
        }
      }

      let hasMore = true

      while (hasMore) {
        if (effectiveSignal.aborted) {
          log.debug('applyCrdtIncrementals aborted', { noteId, lastSeq: since })
          return
        }

        const result = await withRetry(
          () =>
            getFromServer<{
              updates: Array<{
                sequenceNum: number
                data: string
                createdAt: number
                signerDeviceId: string
              }>
              hasMore: boolean
            }>(
              `/sync/crdt/updates?note_id=${encodeURIComponent(noteId)}&since=${since}&limit=100`,
              token
            ),
          { maxRetries: 3, baseDelayMs: 2000, signal: effectiveSignal }
        ).then((r) => r.value)

        log.warn('[DIAG] applyCrdtIncrementals fetched', {
          noteId,
          since,
          updateCount: result.updates.length,
          hasMore: result.hasMore
        })

        const signerIds = new Set(result.updates.map((u) => u.signerDeviceId))
        await Promise.all(Array.from(signerIds).map((sid) => this.resolveDeviceKey(sid)))

        for (const entry of result.updates) {
          const bin = atob(entry.data)
          const packed = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) packed[i] = bin.charCodeAt(i)

          const signerPubKey = await this.resolveDeviceKey(entry.signerDeviceId)
          if (!signerPubKey) {
            log.warn('Skipping CRDT update from unresolvable signer', {
              noteId,
              signerDeviceId: entry.signerDeviceId,
              sequenceNum: entry.sequenceNum
            })
            since = entry.sequenceNum
            continue
          }

          const decrypted = decryptCrdtUpdate(packed, vaultKey, noteId, signerPubKey)
          this.deps.crdtProvider.applyRemoteUpdate(noteId, decrypted)
          since = entry.sequenceNum
        }

        hasMore = result.hasMore
      }

      // Fallback: if server had no CRDT state, seed from local markdown so note is viewable
      const postVector = this.deps.crdtProvider.getStateVector(noteId)
      if (!postVector || postVector.length <= 2) {
        await this.deps.crdtProvider.seedFromMarkdownPublic(noteId)
        log.debug('applyCrdtIncrementals: seeded from markdown as fallback (no server CRDT)', {
          noteId
        })
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        log.debug('applyCrdtIncrementals aborted via signal', { noteId })
        return
      }
      log.warn('Failed to apply CRDT incrementals', {
        noteId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  private async applyCrdtBatch(
    noteIds: string[],
    token: string,
    vaultKey: Uint8Array
  ): Promise<void> {
    if (!this.deps.crdtProvider || !this.abortController) return

    try {
      const sinceMap = new Map<string, number>()

      for (const noteId of noteIds) {
        try {
          await this.deps.crdtProvider.open(noteId, undefined, { skipSeed: true })
        } catch (err) {
          log.warn('Failed to open CRDT doc, skipping note in batch', {
            noteId,
            error: err instanceof Error ? err.message : String(err)
          })
          continue
        }

        let since = 0
        const stateVector = this.deps.crdtProvider.getStateVector(noteId)
        const needsBootstrap = !stateVector || stateVector.length <= 2

        if (needsBootstrap) {
          const snap = await fetchCrdtSnapshot(noteId, token)
          if (snap) {
            const pubKey = await this.resolveDeviceKey(snap.signerDeviceId)
            if (pubKey) {
              const decrypted = decryptCrdtUpdate(snap.snapshot, vaultKey, noteId, pubKey)
              this.deps.crdtProvider.applyRemoteUpdate(noteId, decrypted)
              since = snap.sequenceNum
            } else {
              log.warn('Skipping CRDT snapshot from unresolvable signer in batch', {
                noteId,
                signerDeviceId: snap.signerDeviceId
              })
            }
          }
        }
        sinceMap.set(noteId, since)
      }

      if (sinceMap.size === 0) return

      const activeSince = new Map(sinceMap)

      while (activeSince.size > 0) {
        if (this.abortController.signal.aborted) return

        const notes = Array.from(activeSince, ([noteId, since]) => ({ noteId, since }))

        const result = await withRetry(
          () =>
            postToServer<CrdtBatchPullResponse>(
              '/sync/crdt/updates/batch',
              { notes, limit: 100 },
              token
            ),
          { maxRetries: 3, baseDelayMs: 2000, signal: this.abortController.signal }
        ).then((r) => r.value)

        const signerIds = new Set<string>()
        for (const noteData of Object.values(result.notes)) {
          for (const u of noteData.updates) signerIds.add(u.signerDeviceId)
        }
        await Promise.all(Array.from(signerIds).map((sid) => this.resolveDeviceKey(sid)))

        for (const [noteId, noteData] of Object.entries(result.notes)) {
          for (const entry of noteData.updates) {
            const bin = atob(entry.data)
            const packed = new Uint8Array(bin.length)
            for (let i = 0; i < bin.length; i++) packed[i] = bin.charCodeAt(i)

            const pubKey = await this.resolveDeviceKey(entry.signerDeviceId)
            if (!pubKey) {
              log.warn('Skipping CRDT batch update from unresolvable signer', {
                noteId,
                signerDeviceId: entry.signerDeviceId,
                sequenceNum: entry.sequenceNum
              })
              activeSince.set(noteId, entry.sequenceNum)
              continue
            }
            const decrypted = decryptCrdtUpdate(packed, vaultKey, noteId, pubKey)
            this.deps.crdtProvider!.applyRemoteUpdate(noteId, decrypted)
            activeSince.set(noteId, entry.sequenceNum)
          }

          if (!noteData.hasMore) activeSince.delete(noteId)
        }

        for (const [noteId] of activeSince) {
          if (!result.notes[noteId]) {
            log.warn('Server omitted noteId from batch response, removing', { noteId })
            activeSince.delete(noteId)
          }
        }
      }

      // Fallback: seed from markdown for notes where server had no CRDT state
      for (const noteId of noteIds) {
        const postVector = this.deps.crdtProvider.getStateVector(noteId)
        if (!postVector || postVector.length <= 2) {
          await this.deps.crdtProvider.seedFromMarkdownPublic(noteId)
          log.debug('applyCrdtBatch: seeded from markdown as fallback (no server CRDT)', {
            noteId
          })
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        log.debug('applyCrdtBatch aborted via signal')
        return
      }
      log.warn('Failed to apply CRDT batch', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  private async pullCrdtForNote(noteId: string): Promise<void> {
    log.warn('[DIAG] pullCrdtForNote entered', { noteId })
    const token = await this.deps.getAccessToken()
    if (!token) {
      log.warn('[DIAG] pullCrdtForNote: no access token', { noteId })
      return
    }

    const vaultKey = await this.deps.getVaultKey()
    if (!vaultKey) {
      log.warn('[DIAG] pullCrdtForNote: no vault key', { noteId })
      return
    }

    const localAbort = new AbortController()
    try {
      await this.applyCrdtIncrementals(noteId, token, vaultKey, localAbort.signal)
      log.warn('[DIAG] pullCrdtForNote completed', { noteId })
    } finally {
      secureCleanup(vaultKey)
    }
  }
}
