import type { VectorClock, SyncItemType } from '@memry/contracts/sync-api'
import type { SyncAdapterRegistry } from '@memry/sync-core'
import { getHandler, getRemoteSyncAdapter } from './item-handlers'
import type { ApplyResult, DrizzleDb, EmitToWindows } from './item-handlers'
import { hasPendingDelete } from './pending-deletes'
import { PendingSyncIntentError } from './pending-sync-intent-error'
import { settleItemSyncIntents } from './sync-intents'
import type { PageApplyHandle } from './bulk-apply'
import { recordUnknownPayloadFields } from './unknown-fields'
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

/** 'schema_invalid': the payload failed this build's schema; the pull records it for a retry (#2285). */
export type ApplyItemResult = ApplyResult | 'schema_invalid'

export class ItemApplier {
  /** Applies that changed a local row ('applied' or 'conflict') since construction. */
  changedCount = 0

  constructor(
    private db: DrizzleDb,
    private emitToWindows: EmitToWindows,
    private adapters?: SyncAdapterRegistry<DrizzleDb, EmitToWindows>
  ) {}

  /**
   * `page` routes the apply through the pull's page transaction (see
   * bulk-apply.ts): its data DB, and handler emits held until the page commits
   * (#2294). An item whose apply throws rolls back its own savepoint, so its
   * emits are dropped here rather than queued. Absent, behavior is unchanged.
   */
  apply(
    input: ApplyItemInput,
    page?: Pick<PageApplyHandle, 'db' | 'afterCommit'>
  ): ApplyItemResult {
    const itemEmits: Array<() => void> = []
    const emit: EmitToWindows = page
      ? (channel, data) => itemEmits.push(() => this.emitToWindows(channel, data))
      : this.emitToWindows
    const result = this.dispatch(input, page?.db ?? this.db, emit)
    for (const notify of itemEmits) page?.afterCommit(notify)
    if (result === 'applied' || result === 'conflict') this.changedCount++
    return result
  }

  private dispatch(input: ApplyItemInput, db: DrizzleDb, emit: EmitToWindows): ApplyItemResult {
    const ctx = { db, emit, vaultKey: input.vaultKey }
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
            db,
            emit,
            itemId: input.itemId,
            operation: 'delete',
            clock: input.clock,
            vaultKey: input.vaultKey
          })
        : handler!.applyDelete(ctx, input.itemId, input.clock)
    }

    // Tasks and notes are hard-deleted locally, so "no local row" means both
    // "never had it" and "the user just deleted it". Without this check the
    // handlers insert unconditionally, and any replay of the server's history
    // — a manifest-triggered cursor reset, a re-link, a restore — brings the
    // deleted item back. The tombstone is the only surviving record of the
    // delete until the server acknowledges it.
    if (hasPendingDelete(db, input.type, input.itemId)) {
      log.warn('Refusing a remote upsert for an item deleted locally', {
        type: input.type,
        itemId: input.itemId
      })
      return 'skipped'
    }

    // A local edit whose sync intent has not drained still carries its
    // pre-edit clock; compared against that, a remote row would overwrite the
    // edit. Drain it first. If it still cannot drain, throw: the pull defers
    // the item to its end-of-run retry, then to the schema-invalid ledger as
    // `pending_intent`, re-fetched after the next pull-start drain (#2301).
    if (!settleItemSyncIntents(db, input.type, input.itemId)) {
      throw new PendingSyncIntentError(input.type, input.itemId)
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
      trackMainEvent('sync_skipped_unknown_type', {
        surface: 'sync',
        action: 'schema_validation_failed',
        objectType: 'sync_item',
        result: 'failed',
        dimensions: { itemType: input.type }
      })
      return 'schema_invalid'
    }

    // Zod strips every key the handler schema has no field for, and the push
    // path re-serialises the projection row — so without this capture a field
    // written by a newer client is deleted from the server copy on the next
    // local edit (#2183).
    recordUnknownPayloadFields(db, input.type, input.itemId, parsed, data)

    return adapter
      ? adapter.applyRemoteMutation({
          db,
          emit,
          itemId: input.itemId,
          operation: input.operation,
          data,
          clock: input.clock ?? {},
          vaultKey: input.vaultKey
        })
      : handler!.applyUpsert(ctx, input.itemId, data, input.clock ?? {})
  }
}
