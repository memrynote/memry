import type { VectorClock, SyncItemType } from '@memry/contracts/sync-api'
import type { SyncAdapterRegistry } from '@memry/sync-core'
import { getHandler, getRemoteSyncAdapter } from './item-handlers'
import type { ApplyResult, DrizzleDb, EmitToWindows } from './item-handlers'
import { createLogger } from '../lib/logger'
import { trackMainEvent } from '../telemetry/track'

export type { EmitToWindows, ApplyResult }

const log = createLogger('ItemApplier')

export interface ApplyItemInput {
  itemId: string
  type: SyncItemType
  operation: 'create' | 'update' | 'delete'
  content: Uint8Array
  clock?: VectorClock
  deletedAt?: number
  vaultKey?: Uint8Array
}

export class ItemApplier {
  constructor(
    private db: DrizzleDb,
    private emitToWindows: EmitToWindows,
    private adapters?: SyncAdapterRegistry<DrizzleDb, EmitToWindows>
  ) {}

  apply(input: ApplyItemInput): ApplyResult {
    const ctx = { db: this.db, emit: this.emitToWindows, vaultKey: input.vaultKey }
    const adapter = this.adapters?.getRemote(input.type) ?? getRemoteSyncAdapter(input.type)
    const handler = adapter ? null : getHandler(input.type)

    if (!adapter && !handler) {
      // Mixed-version tripwire: a type the server served that this build has no
      // handler for. #754 negotiation makes this rare (the server filters
      // changes/pull/manifest to the client's declared types), so a hit here
      // signals a newer peer sending a type this build predates.
      log.warn('Unsupported item type for apply', { type: input.type })
      trackMainEvent('sync_skipped_unknown_type', {
        surface: 'sync',
        action: 'apply_skipped',
        objectType: 'sync_item',
        result: 'skipped',
        dimensions: { itemType: input.type }
      })
      return 'skipped'
    }

    if (input.operation === 'delete') {
      return adapter
        ? adapter.applyRemoteMutation({
            db: this.db,
            emit: this.emitToWindows,
            itemId: input.itemId,
            operation: 'delete',
            clock: input.clock,
            vaultKey: input.vaultKey
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
      // Unlike 'parse_error' (corrupt-tracker refetch flow), 'skipped' still
      // advances the cursor and never retries — a schema-drift item from a
      // newer peer silently never lands here. Same mixed-version tripwire as
      // the unknown-type case above, for known types with drifted payloads.
      trackMainEvent('sync_skipped_unknown_type', {
        surface: 'sync',
        action: 'schema_validation_failed',
        objectType: 'sync_item',
        result: 'skipped',
        dimensions: { itemType: input.type }
      })
      return 'skipped'
    }

    return adapter
      ? adapter.applyRemoteMutation({
          db: this.db,
          emit: this.emitToWindows,
          itemId: input.itemId,
          operation: input.operation,
          data,
          clock: input.clock ?? {},
          vaultKey: input.vaultKey
        })
      : handler!.applyUpsert(ctx, input.itemId, data, input.clock ?? {})
  }
}
