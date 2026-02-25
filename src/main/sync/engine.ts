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
  InitialSyncProgressEvent
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
import { postToServer, getFromServer, fetchCrdtSnapshot } from './http-client'
import { checkManifestIntegrity } from './manifest-check'
import { runInitialSeed } from './initial-seed'
import type { CrdtProvider } from './crdt-provider'
import { decryptCrdtUpdate } from './crdt-encrypt'

const log = createLogger('SyncEngine')

const YIELD_EVERY_N_ITEMS = 20
const yieldToEventLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

const PUSH_BATCH_SIZE = 100
const MAX_PUSH_ITERATIONS = 50
const CLOCK_SKEW_THRESHOLD_SECONDS = 300
const PULL_PAGE_LIMIT = 100
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

  async stop(): Promise<void> {
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
    this.deps.network.removeListener('status-changed', this.handleNetworkChange)
    this.deps.ws.removeListener('message', this.handleWsMessage)
    this.deps.ws.removeListener('connected', this.handleWsConnected)
    this.deps.ws.disconnect()
    this.deviceKeyCache.clear()
    this.setState('idle')
    SyncEngine.activeInstance = null
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

        const response = await withRetry(
          () =>
            postToServer<PushResponse>(
              '/sync/push',
              { items: pushItems.map((p) => p.pushItem) },
              token
            ),
          { signal: this.abortController.signal, isOnline: () => this.deps.network.online }
        )

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
      this.lastError = error instanceof Error ? error.message : String(error)
      this.setState('error')
      this.recordHistory('error', 0, Date.now() - startTime, this.lastError)
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
    const startTime = Date.now()
    let pulledCount = 0
    const processedIds = new Set<string>()
    this.deviceKeyCache.clear()

    let totalConflictsResolved = 0

    try {
      let cursor = this.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)
      let hasMore = true

      while (hasMore) {
        if (this.abortController.signal.aborted) break

        const cursorParam = cursor ? `&cursor=${cursor}` : ''
        const changesResult = await withRetry(
          () =>
            getFromServer<ChangesResponse>(
              `/sync/changes?limit=${this.options.pullPageLimit}${cursorParam}`,
              token
            ),
          { signal: this.abortController.signal, isOnline: () => this.deps.network.online }
        )

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
          for (const sid of signerIds) {
            await this.resolveDeviceKey(sid)
          }
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

          const { decrypted, failures } = await decryptPullBatch(itemsToProcess, vaultKey, {
            workerBridge: this.deps.workerBridge,
            resolveDeviceKey: (id) => this.resolveDeviceKey(id)
          })

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
                  await this.applyCrdtIncrementals(dec.id, token, vaultKey)
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
      }

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
      this.lastError = error instanceof Error ? error.message : String(error)
      this.setState('error')
      this.recordHistory('error', 0, Date.now() - startTime, this.lastError)
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
    }
  }

  getStatus(): GetSyncStatusResult {
    return {
      status: this.state,
      lastSyncAt: this.getLastSyncAt(),
      pendingCount: this.deps.queue.getPendingCount(),
      error: this.lastError
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

  private handleWsMessage = (message: WebSocketMessage): void => {
    switch (message.type) {
      case 'changes_available':
        if (!this.isPaused()) {
          this.scheduleSync(() => this.pull())
        }
        break
      case 'crdt_updated': {
        if (!this.isPaused()) {
          const noteId = message.payload?.noteId as string | undefined
          if (noteId && this.deps.crdtProvider) {
            this.scheduleSync(() => this.pullCrdtForNote(noteId))
          }
        }
        break
      }
      case 'heartbeat':
        break
      case 'error':
        log.warn('Server-sent WS error', { payload: message.payload })
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
    }
    this.emitStatusChanged()
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
      error: this.lastError
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
    vaultKey: Uint8Array
  ): Promise<void> {
    if (!this.deps.crdtProvider) return
    if (!this.abortController) return

    try {
      const doc = await this.deps.crdtProvider.open(noteId)
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
        if (this.abortController.signal.aborted) {
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
          { maxRetries: 3, baseDelayMs: 2000, signal: this.abortController.signal }
        ).then((r) => r.value)

        const signerIds = new Set(result.updates.map((u) => u.signerDeviceId))
        for (const sid of signerIds) {
          await this.resolveDeviceKey(sid)
        }

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

  private async pullCrdtForNote(noteId: string): Promise<void> {
    const token = await this.deps.getAccessToken()
    if (!token) return

    const vaultKey = await this.deps.getVaultKey()
    if (!vaultKey) return

    try {
      await this.applyCrdtIncrementals(noteId, token, vaultKey)
    } finally {
      secureCleanup(vaultKey)
    }
  }
}
