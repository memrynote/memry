import type { VectorClock, SyncItemType } from '@shared/contracts/sync-api'
import { getHandler } from './item-handlers'
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
    private emitToWindows: EmitToWindows
  ) {}

  apply(input: ApplyItemInput): ApplyResult {
    const handler = getHandler(input.type)
    if (!handler) {
      log.warn('Unsupported item type for apply', { type: input.type })
      return 'skipped'
    }

    const ctx = { db: this.db, emit: this.emitToWindows }

    if (input.operation === 'delete') {
      return handler.applyDelete(ctx, input.itemId, input.clock)
    }

    const decoded = new TextDecoder().decode(input.content)
    let data: unknown
    try {
      data = handler.schema.parse(JSON.parse(decoded))
    } catch (err) {
      log.error('Invalid payload', { type: input.type, itemId: input.itemId, error: err })
      return 'skipped'
    }

    return handler.applyUpsert(ctx, input.itemId, data, input.clock ?? {})
  }
}
