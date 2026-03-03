import { createLogger } from '../../lib/logger'
import { EVENT_CHANNELS } from '@shared/contracts/ipc-events'
import type { QueueClearedEvent } from '@shared/contracts/ipc-events'
import type { PushResponse, SyncItemType } from '@shared/contracts/sync-api'
import { secureCleanup } from '../../crypto/index'
import { encryptPushBatch } from '../sync-crypto-batch'
import { getHandler } from '../item-handlers'
import { withRetry } from '../retry'
import { postToServer, RateLimitError } from '../http-client'
import { classifyError } from '../sync-errors'
import { isBinaryFileType } from '@shared/file-types'
import { parallelWithLimit } from '../concurrency'
import { SyncTimer } from '../sync-timer'
import type { SyncContext } from './sync-context'
import type { SyncStateManager } from './sync-state-manager'
import {
  SYNC_STATE_KEYS,
  MAX_PUSH_ITERATIONS,
  YIELD_EVERY_N_ITEMS,
  CRDT_SNAPSHOT_CONCURRENCY,
  PUSH_DEBOUNCE_MS,
  yieldToEventLoop
} from './sync-context'

const log = createLogger('PushCoordinator')

export class PushCoordinator {
  private ctx: SyncContext
  private stateManager: SyncStateManager
  private pushDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingPushRequested = false
  suppressPushDuringPull = false

  constructor(ctx: SyncContext, stateManager: SyncStateManager) {
    this.ctx = ctx
    this.stateManager = stateManager
  }

  async push(): Promise<void> {
    const pendingCount = this.ctx.deps.queue.getPendingCount()
    log.debug('Push entered', {
      queuePending: pendingCount,
      queueTotal: this.ctx.deps.queue.getSize(),
      syncing: this.ctx.syncing,
      fullSyncActive: this.ctx.fullSyncActive
    })

    if (pendingCount === 0) {
      log.debug('Push skipped: queue empty')
      return
    }

    const release = await this.ctx.acquireLock()
    if (!release) {
      log.debug('Push skipped', { syncing: this.ctx.syncing, paused: this.stateManager.isPaused() })
      return
    }

    let released = false
    const cleanup = (): void => {
      if (released) return
      released = true
      this.ctx.releaseLock()
      release()
    }

    const timer = new SyncTimer()
    const startTime = Date.now()
    let pushedCount = 0
    let lastServerTime = 0
    let lastMaxCursor = 0
    let vaultKey: Uint8Array | null = null
    let signingSecretKey: Uint8Array | null = null

    try {
      this.stateManager.setState('syncing')
      this.ctx.abortController = new AbortController()

      const token = await this.ctx.deps.getAccessToken()
      if (!token) {
        log.debug('Push aborted: no access token')
        return
      }

      const signingKeys = await this.ctx.deps.getSigningKeys()
      if (!signingKeys) {
        log.debug('Push aborted: no signing keys')
        return
      }
      signingSecretKey = signingKeys.secretKey

      vaultKey = await this.ctx.deps.getVaultKey()
      if (!vaultKey) {
        log.debug('Push aborted: no vault key')
        return
      }

      try {
        for (let iteration = 0; iteration < MAX_PUSH_ITERATIONS; iteration++) {
          if (this.ctx.abortController!.signal.aborted) break

          const preDequeueCount = this.ctx.deps.queue.getPendingCount()
          const rawCount = this.ctx.deps.queue.getRawPendingCount()
          if (preDequeueCount !== rawCount) {
            log.error('Push: Drizzle vs raw SQL mismatch!', {
              drizzle: preDequeueCount,
              raw: rawCount
            })
          }
          const items = this.ctx.deps.queue.dequeue(this.ctx.options.pushBatchSize)
          if (items.length === 0) {
            log.debug('Push complete: queue empty', { preDequeueCount, rawCount })
            break
          }

          const dedupedItems = this.deduplicateByItemId(items)

          if (this.ctx.deps.crdtProvider) {
            const snapshotTasks = dedupedItems
              .filter((item) => {
                if (item.operation !== 'create') return false
                if (item.type !== 'note' && item.type !== 'journal') return false
                try {
                  const parsed = JSON.parse(item.payload) as { fileType?: string }
                  if (parsed.fileType && isBinaryFileType(parsed.fileType)) return false
                } catch {
                  /* no payload parse = assume text */
                }
                return true
              })
              .map((item) => () => this.ctx.deps.crdtProvider!.pushSnapshotForNote(item.itemId))
            if (snapshotTasks.length > 0) {
              const snapshotResults = await parallelWithLimit(
                snapshotTasks,
                CRDT_SNAPSHOT_CONCURRENCY,
                this.ctx.abortController!.signal
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
              workerBridge: this.ctx.deps.workerBridge,
              queue: this.ctx.deps.queue,
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
            {
              signal: this.ctx.abortController!.signal,
              isOnline: () => this.ctx.deps.network.online
            }
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
            if (this.ctx.abortController?.signal.aborted) break
            if (pi > 0 && pi % YIELD_EVERY_N_ITEMS === 0) await yieldToEventLoop()
            const { queueId, pushItem } = pushItems[pi]
            if (acceptedSet.has(pushItem.id)) {
              this.ctx.deps.queue.markSuccess(queueId)
              this.markItemSynced(pushItem.id, pushItem.type as SyncItemType)
              pushedCount++
              this.stateManager.emitItemSynced(pushItem.id, pushItem.type, 'push')
            } else {
              const rejection = response.value.rejected.find((r) => r.id === pushItem.id)
              const reason = rejection?.reason ?? 'Unknown rejection'
              if (reason === 'SYNC_REPLAY_DETECTED') {
                log.info('Push: replay detected, server already has this or newer', {
                  queueId: queueId.slice(0, 8),
                  itemId: pushItem.id.slice(0, 8)
                })
                this.ctx.deps.queue.markSuccess(queueId)
                this.markItemSynced(pushItem.id, pushItem.type as SyncItemType)
              } else if (reason === 'STORAGE_QUOTA_EXCEEDED') {
                log.warn('Push: storage quota exceeded', { itemId: pushItem.id.slice(0, 8) })
                this.ctx.deps.queue.markFailed(queueId, reason)
                this.ctx.lastErrorInfo = {
                  category: 'storage_quota_exceeded',
                  message: 'Storage quota exceeded',
                  retryable: false
                }
                this.ctx.lastError = 'Storage quota exceeded'
                this.stateManager.setState('error')
                break
              } else {
                log.warn('Push: item rejected', {
                  queueId: queueId.slice(0, 8),
                  itemId: pushItem.id.slice(0, 8),
                  reason
                })
                this.ctx.deps.queue.markFailed(queueId, reason)
              }
            }
          }
        }

        log.info('Push timing', timer.finish())

        if (pushedCount > 0) {
          this.stateManager.recordHistory('push', pushedCount, Date.now() - startTime)
          this.stateManager.updateLastSyncAt()
          this.ctx.rateLimitConsecutive = 0
          if (lastServerTime > 0) this.stateManager.checkClockSkew(lastServerTime)

          if (lastMaxCursor > 0) {
            const currentCursor = Number(
              this.stateManager.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR) ?? '0'
            )
            if (lastMaxCursor > currentCursor) {
              this.stateManager.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, String(lastMaxCursor))
              log.debug('Push: advanced pull cursor', { from: currentCursor, to: lastMaxCursor })
            }
          }

          if (this.ctx.deps.queue.getPendingCount() === 0) {
            this.ctx.deps.emitToRenderer(EVENT_CHANNELS.QUEUE_CLEARED, {
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
        this.stateManager.recordHistory('error', 0, Date.now() - startTime, errorInfo.message)
      }
    } finally {
      try {
        if (vaultKey && signingSecretKey) {
          secureCleanup(vaultKey, signingSecretKey)
        } else if (vaultKey) {
          secureCleanup(vaultKey)
        } else if (signingSecretKey) {
          secureCleanup(signingSecretKey)
        }
      } finally {
        cleanup()
      }
    }
  }

  requestPush(): void {
    if (this.stateManager.isPaused() || this.suppressPushDuringPull) return
    this.pendingPushRequested = true
    if (!this.ctx.deps.network.online) return
    if (this.pushDebounceTimer) return

    this.pushDebounceTimer = setTimeout(() => {
      this.pushDebounceTimer = null
      if (this.stateManager.isPaused()) {
        this.pendingPushRequested = false
        return
      }
      if (this.ctx.syncing || this.ctx.fullSyncActive) {
        this.requestPush()
        return
      }
      if (this.pendingPushRequested) {
        this.pendingPushRequested = false
        this.ctx.scheduleSync(() => (this.ctx.doPush ?? (() => this.push()))())
      }
    }, PUSH_DEBOUNCE_MS)
  }

  clearDebounce(): void {
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer)
      this.pushDebounceTimer = null
    }
    this.pendingPushRequested = false
  }

  clearPendingAfterFullSync(): void {
    this.pendingPushRequested = false
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer)
      this.pushDebounceTimer = null
    }
  }

  private markItemSynced(itemId: string, type: SyncItemType): void {
    try {
      const handler = getHandler(type)
      handler?.markPushSynced?.(this.ctx.deps.db, itemId)
    } catch (err) {
      log.warn('Failed to mark item syncedAt after push', { itemId, type, error: err })
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
        this.ctx.deps.queue.markSuccess(id)
      }
    }

    return Array.from(seen.values())
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

  private resolvePushPayload(
    item: { itemId: string; type: string; operation: string; payload: string },
    deviceId: string
  ): string {
    if (item.operation === 'delete') return item.payload

    try {
      const handler = getHandler(item.type as SyncItemType)
      if (!handler?.buildPushPayload) return item.payload

      const fresh = handler.buildPushPayload(
        this.ctx.deps.db,
        item.itemId,
        deviceId,
        item.operation
      )
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
}
