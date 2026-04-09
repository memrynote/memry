import type { SyncItemType, VectorClock } from '@memry/contracts/sync-api'
import type { QueueLike } from './adapter.ts'

export interface RecordSyncControllerDeps<
  TLocal,
  TArgs extends unknown[] = [],
  TDeleteArgs extends unknown[] = [],
  TRecovered = TLocal
> {
  type: SyncItemType
  queue: QueueLike
  getDeviceId: () => string | null
  load(itemId: string): TLocal | undefined
  applyLocalChange(args: {
    itemId: string
    local: TLocal
    deviceId: string
    operation: 'create' | 'update'
    extra: TArgs
  }): TLocal
  serialize(local: TLocal, operation: 'create' | 'update', extra: TArgs): Record<string, unknown>
  handleMissingDevice?(itemId: string, operation: 'create' | 'update', extra: TArgs): void
  shouldSkip?(local: TLocal): boolean
  buildDeletePayload?(args: {
    itemId: string
    local: TLocal | undefined
    deviceId: string
    extra: TDeleteArgs
  }): string | null
  buildFreshPayload?(itemId: string, operation: 'create' | 'update', extra: TArgs): string | null
  recoverPendingChange?(itemId: string, deviceId: string): TRecovered | null
  serializeRecovered?(local: TRecovered): Record<string, unknown>
  priority?: number
}

export class RecordSyncController<
  TLocal,
  TArgs extends unknown[] = [],
  TDeleteArgs extends unknown[] = [],
  TRecovered = TLocal
> {
  constructor(
    private readonly deps: RecordSyncControllerDeps<TLocal, TArgs, TDeleteArgs, TRecovered>
  ) {}

  enqueueCreate(itemId: string, ...extra: TArgs): void {
    this.enqueueMutation(itemId, 'create', extra)
  }

  enqueueUpdate(itemId: string, ...extra: TArgs): void {
    this.enqueueMutation(itemId, 'update', extra)
  }

  enqueueDelete(itemId: string, ...extra: TDeleteArgs): void {
    const deviceId = this.deps.getDeviceId()
    if (!deviceId || !this.deps.buildDeletePayload) return

    const payload = this.deps.buildDeletePayload({
      itemId,
      local: this.deps.load(itemId),
      deviceId,
      extra
    })
    if (payload === null) return

    this.deps.queue.enqueue({
      type: this.deps.type,
      itemId,
      operation: 'delete',
      payload,
      priority: this.deps.priority ?? 0
    })
  }

  enqueueForPush(itemId: string, operation: 'create' | 'update', ...extra: TArgs): void {
    const payload =
      this.deps.buildFreshPayload?.(itemId, operation, extra) ??
      this.buildSerializedPayload(itemId, operation, extra)
    if (!payload) return

    this.deps.queue.enqueue({
      type: this.deps.type,
      itemId,
      operation,
      payload,
      priority: this.deps.priority ?? 0
    })
  }

  enqueueRecoveredUpdate(itemId: string): void {
    const deviceId = this.deps.getDeviceId()
    if (!deviceId) return

    if (!this.deps.recoverPendingChange) {
      this.enqueueForPush(itemId, 'update', ...this.getFallbackArgs())
      return
    }

    const recovered = this.deps.recoverPendingChange(itemId, deviceId)
    if (recovered === null) {
      this.enqueueForPush(itemId, 'update', ...this.getFallbackArgs())
      return
    }

    const payload = JSON.stringify(
      this.deps.serializeRecovered
        ? this.deps.serializeRecovered(recovered)
        : (recovered as Record<string, unknown>)
    )

    this.deps.queue.enqueue({
      type: this.deps.type,
      itemId,
      operation: 'update',
      payload,
      priority: this.deps.priority ?? 0
    })
  }

  private enqueueMutation(itemId: string, operation: 'create' | 'update', extra: TArgs): void {
    const deviceId = this.deps.getDeviceId()
    if (!deviceId) {
      this.deps.handleMissingDevice?.(itemId, operation, extra)
      return
    }

    const local = this.deps.load(itemId)
    if (!local) return
    if (this.deps.shouldSkip?.(local)) return

    const next = this.deps.applyLocalChange({
      itemId,
      local,
      deviceId,
      operation,
      extra
    })
    if (this.deps.shouldSkip?.(next)) return

    this.deps.queue.enqueue({
      type: this.deps.type,
      itemId,
      operation,
      payload: JSON.stringify(this.deps.serialize(next, operation, extra)),
      priority: this.deps.priority ?? 0
    })
  }

  private buildSerializedPayload(
    itemId: string,
    operation: 'create' | 'update',
    extra: TArgs
  ): string | null {
    const local = this.deps.load(itemId)
    if (!local) return null
    if (this.deps.shouldSkip?.(local)) return null
    return JSON.stringify(this.deps.serialize(local, operation, extra))
  }

  private getFallbackArgs(): TArgs {
    return [] as unknown as TArgs
  }
}

export function withIncrementedClock(payload: string, deviceId: string): string {
  try {
    const parsed = JSON.parse(payload) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return payload
    }

    const current = (parsed as { clock?: VectorClock }).clock
    return JSON.stringify({
      ...parsed,
      clock: incrementClock(current, deviceId)
    })
  } catch {
    return payload
  }
}

export function incrementClock(
  existingClock: VectorClock | null | undefined,
  deviceId: string
): VectorClock {
  return {
    ...(existingClock ?? {}),
    [deviceId]: ((existingClock ?? {})[deviceId] ?? 0) + 1
  }
}
