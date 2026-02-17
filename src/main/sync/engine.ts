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
  ClockSkewWarningEvent
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
import { encryptItemForPush } from './encrypt'
import { decryptItemFromPull, SignatureVerificationError } from './decrypt'
import { ItemApplier } from './apply-item'
import { getHandler, type DrizzleDb } from './item-handlers'
import { withRetry } from './retry'
import { postToServer, getFromServer } from './http-client'
import { checkManifestIntegrity } from './manifest-check'
import { runInitialSeed } from './initial-seed'

const log = createLogger('SyncEngine')

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
    log.debug('Periodic pull triggered')
    this.scheduleSync(() => this.pull())
  }

  async push(): Promise<void> {
    log.debug('Push entered', {
      queuePending: this.deps.queue.getPendingCount(),
      queueTotal: this.deps.queue.getSize(),
      syncing: this.syncing,
      fullSyncActive: this.fullSyncActive
    })
    const release = await this.acquireSyncLock()
    if (!release) {
      log.debug('Push skipped', { syncing: this.syncing, paused: this.isPaused() })
      return
    }
    log.debug('Push: lock acquired', { queuePending: this.deps.queue.getPendingCount() })
    this.setState('syncing')
    this.abortController = new AbortController()

    const token = await this.deps.getAccessToken()
    if (!token) {
      log.debug('Push aborted: no access token')
      this.releaseLock()
      release()
      return
    }
    log.debug('Push: token acquired', { queuePending: this.deps.queue.getPendingCount() })

    const signingKeys = await this.deps.getSigningKeys()
    if (!signingKeys) {
      log.debug('Push aborted: no signing keys')
      this.releaseLock()
      release()
      return
    }
    log.debug('Push: signingKeys acquired', { queuePending: this.deps.queue.getPendingCount() })

    const vaultKey = await this.deps.getVaultKey()
    if (!vaultKey) {
      log.debug('Push aborted: no vault key')
      this.releaseLock()
      release()
      return
    }
    log.debug('Push: vaultKey acquired', {
      queuePending: this.deps.queue.getPendingCount(),
      rawPending: this.deps.queue.getRawPendingCount()
    })
    const startTime = Date.now()
    let pushedCount = 0
    let lastServerTime = 0

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

        log.info('Push: dequeued batch', {
          iteration,
          batchSize: items.length,
          items: items.map((i) => ({
            id: i.id.slice(0, 8),
            type: i.type,
            itemId: i.itemId.slice(0, 8),
            attempts: i.attempts
          }))
        })

        const pushItems = items.map((item) => {
          const payloadMeta = this.extractPayloadMetadata(item.payload)
          const result = encryptItemForPush({
            id: item.itemId,
            type: item.type as Parameters<typeof encryptItemForPush>[0]['type'],
            operation: item.operation as Parameters<typeof encryptItemForPush>[0]['operation'],
            content: new TextEncoder().encode(item.payload),
            vaultKey,
            signingSecretKey: signingKeys.secretKey,
            signerDeviceId: signingKeys.deviceId,
            clock: payloadMeta.clock,
            stateVector: payloadMeta.stateVector,
            ...(item.operation === 'delete' && {
              deletedAt: Math.floor(Date.now() / 1000)
            })
          })
          return { queueId: item.id, pushItem: result.pushItem }
        })

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
        const acceptedSet = new Set(response.value.accepted)
        for (const { queueId, pushItem } of pushItems) {
          if (acceptedSet.has(pushItem.id)) {
            this.deps.queue.markSuccess(queueId)
            pushedCount++
            this.emitItemSynced(pushItem.id, pushItem.type, 'push')
          } else {
            const rejection = response.value.rejected.find((r) => r.id === pushItem.id)
            log.warn('Push: item rejected', {
              queueId: queueId.slice(0, 8),
              itemId: pushItem.id.slice(0, 8),
              reason: rejection?.reason ?? 'Unknown rejection'
            })
            this.deps.queue.markFailed(queueId, rejection?.reason ?? 'Unknown rejection')
          }
        }
      }

      if (pushedCount > 0) {
        this.recordHistory('push', pushedCount, Date.now() - startTime)
        this.updateLastSyncAt()
        if (lastServerTime > 0) this.checkClockSkew(lastServerTime)

        if (this.deps.queue.getPendingCount() === 0) {
          this.deps.emitToRenderer(EVENT_CHANNELS.QUEUE_CLEARED, {
            itemCount: pushedCount,
            duration: Date.now() - startTime
          } satisfies QueueClearedEvent)
        }
      }
    } catch (error) {
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
    if (this.isPaused()) return
    this.pendingPushRequested = true
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

        log.debug('Pull: changes fetched', {
          itemCount: changes.items.length,
          deletedCount: changes.deleted.length,
          cursor,
          nextCursor: changes.nextCursor
        })

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
            await this.deps.getDevicePublicKey(sid)
          }
          log.debug('Pull: device keys prefetched', { signerCount: signerIds.size })

          let pageApplied = 0
          let pageSkipped = 0
          let pageFailed = 0
          let cryptoFailCount = 0

          for (const item of parsed.data.items) {
            if (processedIds.has(item.id)) {
              log.debug('Skipping duplicate item in pull', { itemId: item.id })
              pageSkipped++
              continue
            }

            try {
              const signerPubKey = await this.deps.getDevicePublicKey(item.signerDeviceId)
              if (!signerPubKey) {
                log.warn('Skipping item from unresolvable signer device', {
                  itemId: item.id,
                  signerDeviceId: item.signerDeviceId
                })
                pageSkipped++
                continue
              }

              log.debug('Pull: verifying item', {
                itemId: item.id,
                signerDeviceId: item.signerDeviceId,
                operation: item.operation,
                cryptoVersion: item.cryptoVersion,
                hasMetadata: !!(item.clock || item.stateVector),
                signaturePrefix: item.signature.slice(0, 8)
              })

              const decrypted = decryptItemFromPull({
                id: item.id,
                type: item.type,
                operation: item.operation,
                cryptoVersion: item.cryptoVersion,
                encryptedKey: item.blob.encryptedKey,
                keyNonce: item.blob.keyNonce,
                encryptedData: item.blob.encryptedData,
                dataNonce: item.blob.dataNonce,
                signature: item.signature,
                signerDeviceId: item.signerDeviceId,
                deletedAt: item.deletedAt,
                metadata:
                  item.clock || item.stateVector
                    ? {
                        ...(item.clock ? { clock: item.clock } : {}),
                        ...(item.stateVector ? { stateVector: item.stateVector } : {})
                      }
                    : undefined,
                vaultKey,
                signerPublicKey: signerPubKey
              })

              const itemOp = item.deletedAt ? 'delete' : (item.operation as 'create' | 'update')
              const result = this.applier.apply({
                itemId: item.id,
                type: item.type as Parameters<ItemApplier['apply']>[0]['type'],
                operation: itemOp,
                content: decrypted.content,
                clock: item.clock,
                deletedAt: item.deletedAt
              })

              if (result === 'conflict') {
                let remoteVersion: Record<string, unknown> = {}
                try {
                  const parsedRemote = JSON.parse(
                    new TextDecoder().decode(decrypted.content)
                  ) as unknown
                  if (
                    parsedRemote &&
                    typeof parsedRemote === 'object' &&
                    !Array.isArray(parsedRemote)
                  ) {
                    remoteVersion = parsedRemote as Record<string, unknown>
                  }
                  if (item.clock) remoteVersion.clock = item.clock
                } catch {
                  log.warn('Failed to parse remote content for conflict event', {
                    itemId: item.id
                  })
                }

                const localVersion = this.fetchLocalItem(item.id, item.type)

                this.deps.emitToRenderer(EVENT_CHANNELS.CONFLICT_DETECTED, {
                  itemId: item.id,
                  type: item.type,
                  localVersion,
                  remoteVersion,
                  localClock: (localVersion.clock as Record<string, number>) ?? undefined,
                  remoteClock: item.clock ?? undefined
                } satisfies ConflictDetectedEvent)
              }

              processedIds.add(item.id)
              pulledCount++
              pageApplied++
              this.emitItemSynced(item.id, item.type, 'pull', itemOp)
            } catch (itemError) {
              const isCryptoError =
                itemError instanceof SignatureVerificationError ||
                (itemError instanceof Error &&
                  (itemError.message.includes('signature') ||
                    itemError.message.includes('decrypt') ||
                    itemError.message.includes('sodium') ||
                    itemError.message.includes('nonce') ||
                    itemError.message.includes('base64')))

              log.error('Pull: failed to process item', {
                itemId: item.id,
                type: item.type,
                signerDeviceId: item.signerDeviceId,
                isCryptoError,
                error: itemError instanceof Error ? itemError.message : String(itemError)
              })
              pageFailed++
              if (isCryptoError) cryptoFailCount++
            }
          }

          log.info('Pull page processed', {
            total: parsed.data.items.length,
            applied: pageApplied,
            skipped: pageSkipped,
            failed: pageFailed
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

        this.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, String(changes.nextCursor))
        cursor = String(changes.nextCursor)
        hasMore = changes.hasMore
      }

      log.debug('Pull complete', { totalPulled: pulledCount, finalCursor: cursor })
      this.recordHistory('pull', pulledCount, Date.now() - startTime)
      this.updateLastSyncAt()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.setState('error')
      this.recordHistory('error', 0, Date.now() - startTime, this.lastError)
    } finally {
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

      await this.push()
      log.debug('fullSync: push complete')

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

      if (this.pushDebounceTimer) {
        clearTimeout(this.pushDebounceTimer)
        this.pushDebounceTimer = null
        this.pendingPushRequested = false
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
      case 'heartbeat':
        break
      case 'error':
        this.log.warn('Server-sent WS error', { payload: message.payload })
        break
      default:
        this.log.debug('Unknown WS message type', { type: (message as { type: string }).type })
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
}
