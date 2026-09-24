import { EVENT_CHANNELS, type ItemRecoveredEvent } from '@memry/contracts/ipc-events'
import { createLogger } from '../../lib/logger'
import { trackMainLog } from '../../telemetry/diagnostics'
import { sortByApplyOrder } from './apply-order'
import { reportConflict } from './conflict-report'
import type { CorruptItemTracker, ItemRef, RecoveredItem } from './corrupt-item-tracker'
import type { SchemaInvalidLedger } from './schema-invalid-ledger'
import type { SyncContext } from './sync-context'

const log = createLogger('ItemRecovery')

export interface ItemRecoveryDeps {
  ctx: SyncContext
  tracker: CorruptItemTracker
  ledger: SchemaInvalidLedger
  onChanged: (item: RecoveredItem, operation: 'create' | 'update' | 'delete') => void
}

/**
 * Applies re-fetched items in FK order, outside any page transaction. A
 * payload this build refuses goes into the schema-invalid ledger; one that
 * applies (or is skipped as older) leaves it (#2285).
 */
export function applyRecoveredItems(
  deps: ItemRecoveryDeps,
  recovered: RecoveredItem[],
  vaultKey: Uint8Array
): void {
  const refused: ItemRef[] = []
  const settled: ItemRef[] = []
  for (const dec of sortByApplyOrder(recovered)) {
    try {
      const operation = dec.deletedAt ? 'delete' : (dec.operation as 'create' | 'update')
      const result = deps.ctx.applier.apply({
        itemId: dec.id,
        type: dec.type as Parameters<typeof deps.ctx.applier.apply>[0]['type'],
        operation,
        content: new TextEncoder().encode(dec.content),
        clock: dec.clock,
        deletedAt: dec.deletedAt,
        vaultKey
      })
      if (result === 'schema_invalid') {
        refused.push(dec)
        continue
      }
      if (result === 'parse_error') {
        deps.tracker.markFailed(dec)
        continue
      }
      settled.push(dec)
      if (result === 'skipped') continue
      // Unrequeued, the merged row keeps a union clock nothing pushes,
      // which is the one way #2180 really strands two devices.
      if (result === 'conflict') reportConflict(deps.ctx.deps, dec)
      deps.onChanged(dec, operation)
      deps.ctx.deps.emitToRenderer(EVENT_CHANNELS.ITEM_RECOVERED, {
        itemId: dec.id,
        type: dec.type
      } satisfies ItemRecoveredEvent)
      log.info('Recovered item', { itemId: dec.id, type: dec.type })
    } catch (err) {
      deps.tracker.markFailed(dec)
      log.error('Failed to apply recovered item', {
        itemId: dec.id,
        error: err instanceof Error ? err.message : String(err)
      })
      trackMainLog('error', {
        scope: 'ItemRecovery',
        action: 'pull_apply_dropped',
        errorCode: dec.type
      })
    }
  }
  deps.ledger.record(refused, 'payload')
  deps.ledger.resolve(settled)
}

/** Re-fetches the ledger's retryable entries by id and applies them again (#2285). */
export async function retrySchemaInvalidItems(
  deps: ItemRecoveryDeps,
  token: string,
  vaultKey: Uint8Array
): Promise<void> {
  const retryable = deps.ledger.retryable()
  if (retryable.length === 0) return
  const { recovered, missing, invalid } = await deps.tracker.refetch(retryable, token, vaultKey)
  deps.ledger.resolve(missing)
  deps.ledger.record(invalid, 'envelope')
  applyRecoveredItems(deps, recovered, vaultKey)
  log.info('Retried schema-invalid items', {
    retryable: retryable.length,
    recovered: recovered.length,
    missing: missing.length,
    invalid: invalid.length
  })
}
