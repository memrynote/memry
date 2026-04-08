import type { VectorClock, SyncItemType } from '@memry/contracts/sync-api'
import type { SyncAdapterRegistry } from '@memry/sync-core'
import { getHandler, getRemoteSyncAdapter } from './item-handlers'
import type { ApplyResult, DrizzleDb, EmitToWindows } from './item-handlers'
import { createLogger } from '../lib/logger'

export type { EmitToWindows, ApplyResult }

const log = createLogger('ItemApplier')

export interface ApplyItemInput {
  itemId: string
  type: SyncItemType
  operation: 'create' | 'update' | 'delete'
  content: Uint8Array
  clock?: VectorClock
  deletedAt?: number
}

export class ItemApplier {
  constructor(
    private db: DrizzleDb,
    private emitToWindows: EmitToWindows,
    private adapters?: SyncAdapterRegistry<DrizzleDb, EmitToWindows>
  ) {}

  apply(input: ApplyItemInput): ApplyResult {
    const ctx = { db: this.db, emit: this.emitToWindows }
    const adapter = this.adapters?.getRemote(input.type) ?? getRemoteSyncAdapter(input.type)
    const handler = adapter ? null : getHandler(input.type)

    if (!adapter && !handler) {
      log.warn('Unsupported item type for apply', { type: input.type })
      return 'skipped'
    }

    if (input.operation === 'delete') {
      return adapter
        ? adapter.applyRemoteMutation({
            db: this.db,
            emit: this.emitToWindows,
            itemId: input.itemId,
            operation: 'delete',
            clock: input.clock
          })
        : handler!.applyDelete(ctx, input.itemId, input.clock)
    }

    const decoded = new TextDecoder().decode(input.content)
    let parsed: unknown
    try {
      parsed = JSON.parse(decoded)
    } catch (err) {
      log.error('JSON parse failed', { type: input.type, itemId: input.itemId, error: err })
      return 'parse_error'
    }

    let data: unknown
    try {
      data = adapter ? adapter.schema.parse(parsed) : handler!.schema.parse(parsed)
    } catch (err) {
      log.error('Schema validation failed', { type: input.type, itemId: input.itemId, error: err })
      return 'skipped'
    }

    return adapter
      ? adapter.applyRemoteMutation({
          db: this.db,
          emit: this.emitToWindows,
          itemId: input.itemId,
          operation: input.operation,
          data,
          clock: input.clock ?? {}
        })
      : handler!.applyUpsert(ctx, input.itemId, data, input.clock ?? {})
  }
}
