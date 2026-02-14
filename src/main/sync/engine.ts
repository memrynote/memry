import { EventEmitter } from 'events'
import { createLogger } from '../lib/logger'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '@shared/db/schema/data-schema'
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
import type { ChangesResponse, PushResponse } from '@shared/contracts/sync-api'
import { SyncQueueManager, type QueueStats } from './queue'
import { NetworkMonitor } from './network'
import { WebSocketManager, type WebSocketMessage } from './websocket'
import { encryptItemForPush } from './encrypt'
import { decryptItemFromPull } from './decrypt'
import { ItemApplier } from './apply-item'
import { withRetry } from './retry'
import { postToServer, getFromServer } from './http-client'
import { checkManifestIntegrity } from './manifest-check'

type DrizzleDb = BetterSQLite3Database<typeof schema>

const log = createLogger('SyncEngine')

const PUSH_BATCH_SIZE = 100
const MAX_PUSH_ITERATIONS = 50
const CLOCK_SKEW_THRESHOLD_SECONDS = 300
const PULL_PAGE_LIMIT = 100
const SYNC_STATE_KEYS = {
  LAST_CURSOR: 'lastCursor',
  LAST_SYNC_AT: 'lastSyncAt',
  SYNC_PAUSED: 'syncPaused'
} as const

let instance: SyncEngine | null = null

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
  private state: SyncStatusValue = 'idle'
  private syncing = false
  private lastError: string | undefined
  private deps: SyncEngineDeps
  private options: SyncEngineOptions
  private abortController: AbortController | null = null
  private inFlightSync: Promise<void> | null = null
  private applier: ItemApplier

  constructor(deps: SyncEngineDeps, options?: Partial<SyncEngineOptions>) {
    super()
    if (instance && instance.syncing) {
      throw new Error('SyncEngine instance already active — call stop() before creating a new one')
    }
    this.deps = deps
    this.options = {
      pushBatchSize: options?.pushBatchSize ?? PUSH_BATCH_SIZE,
      pullPageLimit: options?.pullPageLimit ?? PULL_PAGE_LIMIT
    }
    this.applier = new ItemApplier(deps.db, deps.emitToRenderer)
    instance = this
  }

  get currentState(): SyncStatusValue {
    return this.state
  }

  async start(): Promise<void> {
    this.deps.network.on('status-changed', this.handleNetworkChange)
    this.deps.ws.on('message', this.handleWsMessage)
    this.deps.ws.on('connected', this.handleWsConnected)

    if (this.deps.network.online) {
      await this.deps.ws.connect()
      if (!this.isPaused()) {
        await this.fullSync()
      }
    } else {
      this.setState('offline')
    }
  }

  async stop(): Promise<void> {
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
    instance = null
  }

  async push(): Promise<void> {
    if (this.syncing || this.isPaused()) return
    this.syncing = true
    this.setState('syncing')
    this.abortController = new AbortController()

    const token = await this.deps.getAccessToken()
    if (!token) {
      this.releaseLock()
      return
    }

    const signingKeys = await this.deps.getSigningKeys()
    if (!signingKeys) {
      this.releaseLock()
      return
    }

    const vaultKey = await this.deps.getVaultKey()
    if (!vaultKey) {
      this.releaseLock()
      return
    }
    const startTime = Date.now()
    let pushedCount = 0
    let lastServerTime = 0

    try {
      for (let iteration = 0; iteration < MAX_PUSH_ITERATIONS; iteration++) {
        if (this.abortController.signal.aborted) break

        const items = this.deps.queue.dequeue(this.options.pushBatchSize)
        if (items.length === 0) break

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
            stateVector: payloadMeta.stateVector
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

        const acceptedSet = new Set(response.value.accepted)
        for (const { queueId, pushItem } of pushItems) {
          if (acceptedSet.has(pushItem.id)) {
            this.deps.queue.markSuccess(queueId)
            pushedCount++
            this.emitItemSynced(pushItem.id, pushItem.type, 'push')
          } else {
            const rejection = response.value.rejected.find((r) => r.id === pushItem.id)
            this.deps.queue.markFailed(queueId, rejection?.reason ?? 'Unknown rejection')
          }
        }

        lastServerTime = response.value.serverTime
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
      this.syncing = false
      this.abortController = null
      if (this.state === 'syncing') {
        this.setState(this.deps.network.online ? 'idle' : 'offline')
      }
    }
  }

  async pull(): Promise<void> {
    if (this.syncing || this.isPaused()) return
    this.syncing = true
    this.setState('syncing')
    this.abortController = new AbortController()

    const token = await this.deps.getAccessToken()
    if (!token) {
      this.releaseLock()
      return
    }

    const vaultKey = await this.deps.getVaultKey()
    if (!vaultKey) {
      this.releaseLock()
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

        const itemIds = Array.from(
          new Set([...changes.items.map((item) => item.id), ...changes.deleted])
        )
        if (itemIds.length > 0) {
          const pullResult = await withRetry(
            () =>
              postToServer<{ items: Array<PullItemResponse> }>('/sync/pull', { itemIds }, token),
            { signal: this.abortController.signal, isOnline: () => this.deps.network.online }
          )

          for (const item of pullResult.value.items) {
            if (processedIds.has(item.id)) {
              log.debug('Skipping duplicate item in pull', { itemId: item.id })
              continue
            }
            const signerPubKey = await this.deps.getDevicePublicKey(item.signerDeviceId)
            if (!signerPubKey) continue

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
                  ? { clock: item.clock, stateVector: item.stateVector }
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
                remoteVersion = JSON.parse(new TextDecoder().decode(decrypted.content))
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
            this.emitItemSynced(item.id, item.type, 'pull', itemOp)
          }
        }

        this.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, String(changes.nextCursor))
        cursor = String(changes.nextCursor)
        hasMore = changes.hasMore
      }

      this.recordHistory('pull', pulledCount, Date.now() - startTime)
      this.updateLastSyncAt()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.setState('error')
      this.recordHistory('error', 0, Date.now() - startTime, this.lastError)
    } finally {
      this.syncing = false
      this.abortController = null
      if (this.state === 'syncing') {
        this.setState(this.deps.network.online ? 'idle' : 'offline')
      }
    }
  }

  async fullSync(): Promise<void> {
    await this.pull()
    await this.push()
    await checkManifestIntegrity({
      db: this.deps.db,
      queue: this.deps.queue,
      getAccessToken: this.deps.getAccessToken,
      isOnline: () => this.deps.network.online
    })
    this.deps.queue.purgeOldErrors(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
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
    this.inFlightSync = fn()
      .catch((error) => {
        log.error('Scheduled sync failed', error)
      })
      .finally(() => {
        this.inFlightSync = null
      })
  }

  private handleNetworkChange = ({ online }: { online: boolean }): void => {
    if (online) {
      this.setState('idle')
      void this.deps.ws.connect()
      if (!this.isPaused()) {
        this.scheduleSync(() => this.fullSync())
      }
    } else {
      this.setState('offline')
      this.deps.ws.disconnect()
    }
  }

  private handleWsMessage = (message: WebSocketMessage): void => {
    if (message.type === 'changes_available' && !this.isPaused()) {
      this.scheduleSync(() => this.pull())
    }
  }

  private handleWsConnected = (): void => {
    if (!this.isPaused()) {
      this.scheduleSync(() => this.pull())
    }
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
    } catch {
      return {}
    }
  }

  private fetchLocalItem(itemId: string, type: string): Record<string, unknown> {
    try {
      let row: Record<string, unknown> | undefined
      switch (type) {
        case 'task':
          row = this.deps.db
            .select()
            .from(schema.tasks)
            .where(eq(schema.tasks.id, itemId))
            .get() as Record<string, unknown> | undefined
          break
        case 'project':
          row = this.deps.db
            .select()
            .from(schema.projects)
            .where(eq(schema.projects.id, itemId))
            .get() as Record<string, unknown> | undefined
          break
        case 'inbox':
          row = this.deps.db
            .select()
            .from(schema.inboxItems)
            .where(eq(schema.inboxItems.id, itemId))
            .get() as Record<string, unknown> | undefined
          break
        case 'filter':
          row = this.deps.db
            .select()
            .from(schema.savedFilters)
            .where(eq(schema.savedFilters.id, itemId))
            .get() as Record<string, unknown> | undefined
          break
        default:
          return {}
      }
      return row ?? {}
    } catch {
      log.warn('Failed to fetch local item for conflict', { itemId, type })
      return {}
    }
  }
}

interface PullItemResponse {
  id: string
  type: string
  operation: string
  cryptoVersion?: number
  signature: string
  signerDeviceId: string
  deletedAt?: number
  clock?: Record<string, number>
  stateVector?: string
  blob: {
    encryptedKey: string
    keyNonce: string
    encryptedData: string
    dataNonce: string
  }
}
