import { eq } from 'drizzle-orm'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { syncHistory } from '@memry/db-schema/schema/sync-history'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import type {
  SyncStatusChangedEvent,
  ItemSyncedEvent,
  SyncPausedEvent,
  SyncResumedEvent,
  ClockSkewWarningEvent
} from '@memry/contracts/ipc-events'
import type { SyncStatusValue } from '@memry/contracts/ipc-sync-ops'
import { createLogger } from '../../lib/logger'
import type { SyncContext } from './sync-context'
import { SYNC_STATE_KEYS, CLOCK_SKEW_THRESHOLD_SECONDS } from './sync-context'

const log = createLogger('SyncStateManager')

export type NodeEmit = (event: string, ...args: unknown[]) => boolean

export class SyncStateManager {
  private ctx: SyncContext
  private nodeEmit: NodeEmit

  constructor(ctx: SyncContext, nodeEmit: NodeEmit) {
    this.ctx = ctx
    this.nodeEmit = nodeEmit
  }

  get currentState(): SyncStatusValue {
    return this.ctx.state
  }

  setState(newState: SyncStatusValue): void {
    if (this.ctx.state === newState) return
    const wasOffline = this.ctx.state === 'offline'
    this.ctx.state = newState
    if (newState === 'offline' && !wasOffline) {
      this.ctx.offlineSince = Date.now()
    } else if (newState !== 'offline') {
      this.ctx.offlineSince = null
    }
    if (newState !== 'error') {
      this.ctx.lastError = undefined
      this.ctx.lastErrorInfo = undefined
    }
    this.emitStatusChanged()
  }

  isPaused(): boolean {
    return this.getStateValue(SYNC_STATE_KEYS.SYNC_PAUSED) === 'true'
  }

  getStateValue(key: string): string | undefined {
    const rows = this.ctx.deps.db.select().from(syncState).where(eq(syncState.key, key)).all()
    return rows[0]?.value
  }

  setStateValue(key: string, value: string): void {
    this.ctx.deps.db
      .insert(syncState)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: syncState.key,
        set: { value, updatedAt: new Date() }
      })
      .run()
  }

  getLastSyncAt(): number | undefined {
    const val = this.getStateValue(SYNC_STATE_KEYS.LAST_SYNC_AT)
    return val ? parseInt(val, 10) : undefined
  }

  updateLastSyncAt(): void {
    this.setStateValue(SYNC_STATE_KEYS.LAST_SYNC_AT, String(Date.now()))
  }

  recordHistory(
    type: 'push' | 'pull' | 'error',
    itemCount: number,
    durationMs: number,
    details?: string
  ): void {
    this.ctx.deps.db
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

  emitStatusChanged(): void {
    const event: SyncStatusChangedEvent = {
      status: this.ctx.state,
      lastSyncAt: this.getLastSyncAt(),
      pendingCount: this.ctx.deps.queue.getPendingCount(),
      error: this.ctx.lastError,
      errorCategory: this.ctx.lastErrorInfo?.category,
      offlineSince: this.ctx.offlineSince ?? undefined
    }
    this.ctx.deps.emitToRenderer(EVENT_CHANNELS.STATUS_CHANGED, event)
    this.nodeEmit('status-changed', event)
  }

  emitItemSynced(
    itemId: string,
    type: string,
    operation: 'push' | 'pull',
    itemOperation?: 'create' | 'update' | 'delete'
  ): void {
    const event: ItemSyncedEvent = { itemId, type, operation, itemOperation }
    this.ctx.deps.emitToRenderer(EVENT_CHANNELS.ITEM_SYNCED, event)
    this.nodeEmit('item-synced', event)
  }

  emitPaused(pendingCount: number): void {
    const event: SyncPausedEvent = { pendingCount }
    this.ctx.deps.emitToRenderer(EVENT_CHANNELS.PAUSED, event)
    this.nodeEmit('paused', event)
  }

  emitResumed(pendingCount: number): void {
    const event: SyncResumedEvent = { pendingCount }
    this.ctx.deps.emitToRenderer(EVENT_CHANNELS.RESUMED, event)
    this.nodeEmit('resumed', event)
  }

  checkClockSkew(serverTimeSeconds: number): void {
    const localTimeSeconds = Math.floor(Date.now() / 1000)
    const skew = Math.abs(localTimeSeconds - serverTimeSeconds)
    if (skew > CLOCK_SKEW_THRESHOLD_SECONDS) {
      log.error('Clock skew detected, pausing sync', {
        localTimeSeconds,
        serverTimeSeconds,
        skewSeconds: skew
      })
      this.ctx.deps.emitToRenderer(EVENT_CHANNELS.CLOCK_SKEW_WARNING, {
        localTime: localTimeSeconds,
        serverTime: serverTimeSeconds,
        skewSeconds: skew
      } satisfies ClockSkewWarningEvent)
      this.setStateValue(SYNC_STATE_KEYS.SYNC_PAUSED, 'true')
      this.ctx.abortController?.abort()
      const pendingCount = this.ctx.deps.queue.getPendingCount()
      this.emitPaused(pendingCount)
    }
  }
}
