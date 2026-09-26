import {
  EVENT_CHANNELS,
  type ItemCorruptEvent,
  type ItemRecoveredEvent
} from '@memry/contracts/ipc-events'
import { MissingSyncParentError } from '@memry/sync-client/item-handlers/types'
import { createLogger } from '../../lib/logger'
import { trackMainLog } from '../../telemetry/diagnostics'
import { sortByApplyOrder } from './apply-order'
import { reportConflict } from './conflict-report'
import type { CorruptItemTracker, ItemRef, RecoveredItem } from './corrupt-item-tracker'
import type { SchemaInvalidLedger } from './schema-invalid-ledger'
import type { OrphanRef } from './orphan-repair'
import { PendingSyncIntentError } from '../pending-sync-intent-error'
import { MAX_NOTE_BODY_HEALS_PER_PULL, NOTE_BODY_ITEM_TYPE, type SyncContext } from './sync-context'

const log = createLogger('ItemRecovery')

export interface ItemRecoveryDeps {
  ctx: SyncContext
  tracker: CorruptItemTracker
  ledger: SchemaInvalidLedger
  onChanged: (item: RecoveredItem, operation: 'create' | 'update' | 'delete') => void
  /**
   * Heal a refused change-feed body (#2297), which has no record to re-fetch
   * by id; true resolves the entry. See `NoteBodyFeed.heal`.
   */
  pullNoteBody?: (noteId: string, token: string, vaultKey: Uint8Array) => Promise<boolean>
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
  const waiting: ItemRef[] = []
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
      // Not corrupt: this device's own edit of the item is not clocked yet.
      if (err instanceof PendingSyncIntentError) {
        waiting.push(dec)
        continue
      }
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
  deps.ledger.record(waiting, 'pending_intent')
  deps.ledger.resolve(settled)
}

/**
 * A pull's deferred retry that threw again (extracted from PullCoordinator).
 * A missing FK parent goes to orphan repair (#837). An item still waiting on
 * this device's own sync intent goes to the ledger and is re-fetched after the
 * next pull-start drain (#2301). Anything else is dropped until the item's
 * next remote update, and counted.
 */
export function routeDeferredRetryFailure(
  item: OrphanRef['item'],
  error: unknown,
  orphans: OrphanRef[],
  ledger: SchemaInvalidLedger
): void {
  if (error instanceof MissingSyncParentError) {
    // Not a dead end: the parent may simply sit outside this run's cursor
    // window, or be gone everywhere. repairOrphans() tells them apart instead
    // of dropping the item until some future remote update (which, for a
    // cascade-deleted project, never comes).
    orphans.push({ item, parentType: error.parentType, parentId: error.parentId })
    log.warn('Pull: deferred retry still missing FK parent — queued for repair', {
      itemId: item.id,
      type: item.type,
      parentType: error.parentType,
      parentId: error.parentId
    })
    return
  }
  if (error instanceof PendingSyncIntentError) {
    ledger.record([item], 'pending_intent')
    log.info('Pull: item deferred behind a pending local sync intent', {
      itemId: item.id,
      type: item.type
    })
    return
  }
  log.error('Pull: deferred retry failed — item skipped until next remote update', {
    itemId: item.id,
    type: item.type,
    error: error instanceof Error ? error.message : String(error)
  })
  // For an item that never gets another server-side update this is permanent
  // absence on this device — count the drop per type.
  trackMainLog('error', {
    scope: 'PullCoordinator',
    action: 'pull_apply_dropped',
    errorCode: item.type
  })
}

/**
 * A pulled slice's crypto and parse failures, re-fetched by id once after the
 * slice committed: the recovered ones apply (outside any page transaction),
 * the rest are surfaced as corrupt. Extracted from PullCoordinator.
 */
export async function refetchCorruptItems(
  deps: ItemRecoveryDeps,
  refs: ItemRef[],
  accessJwt: string,
  vaultKey: Uint8Array
): Promise<void> {
  deps.tracker.clearExpired()
  const { recovered, permanentFailures, blobMissing } = await deps.tracker.refetch(
    refs,
    accessJwt,
    vaultKey
  )
  // A lost blob stays quarantined so the manifest does not count it server-only (#2302).
  deps.ledger.record(blobMissing, 'blob_missing')
  applyRecoveredItems(deps, recovered, vaultKey)

  for (const ref of permanentFailures) {
    deps.ctx.deps.emitToRenderer(EVENT_CHANNELS.ITEM_CORRUPT, {
      itemId: ref.id,
      type: ref.type,
      error: 'Item corrupt after re-fetch attempt'
    } satisfies ItemCorruptEvent)
  }

  if (recovered.length > 0 || permanentFailures.length > 0) {
    log.info('Pull: re-fetch summary', {
      recovered: recovered.length,
      permanentFailures: permanentFailures.length
    })
  }
}

/** Re-fetches the ledger's retryable entries by id and applies them again (#2285). */
export async function retrySchemaInvalidItems(
  deps: ItemRecoveryDeps,
  token: string,
  vaultKey: Uint8Array
): Promise<void> {
  const all = deps.ledger.retryable()
  const retryable = all.filter((ref) => ref.type !== NOTE_BODY_ITEM_TYPE)
  const bodies = all.filter((ref) => ref.type === NOTE_BODY_ITEM_TYPE)
  for (const ref of deps.pullNoteBody ? bodies.slice(0, MAX_NOTE_BODY_HEALS_PER_PULL) : []) {
    // A failed heal is recorded again, so it waits out the cooldown instead of
    // running ahead of every pull.
    if (await deps.pullNoteBody!(ref.id, token, vaultKey)) deps.ledger.resolve([ref])
    else deps.ledger.record([ref], 'envelope')
  }
  if (retryable.length === 0) return
  const { recovered, missing, invalid, blobMissing } = await deps.tracker.refetch(
    retryable,
    token,
    vaultKey
  )
  deps.ledger.resolve(missing)
  deps.ledger.record(invalid, 'envelope')
  deps.ledger.record(blobMissing, 'blob_missing')
  applyRecoveredItems(deps, recovered, vaultKey)
  log.info('Retried schema-invalid items', {
    retryable: retryable.length,
    recovered: recovered.length,
    missing: missing.length,
    invalid: invalid.length,
    blobMissing: blobMissing.length
  })
}
