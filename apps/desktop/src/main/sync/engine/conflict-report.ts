import { createLogger } from '../../lib/logger'
import type { SyncItemType } from '@memry/contracts/sync-api'
import { trackMainLog } from '../../telemetry/diagnostics'

const log = createLogger('PullCoordinator')

/**
 * A remote-vs-local concurrent edit, already field-merged by the item handler.
 * Nothing is lost and nothing needs the user, so it is logged, not surfaced.
 * The only work left is re-queueing the item so the merged state pushes back.
 */
export function reportConflict(
  deps: {
    queue: {
      enqueue: (item: {
        type: SyncItemType
        itemId: string
        operation: 'update'
        payload: string
      }) => void
    }
  },
  dec: { id: string; type: string; clock?: Record<string, number> }
): void {
  log.info('Merged concurrent edit', { itemId: dec.id, type: dec.type, remoteClock: dec.clock })

  deps.queue.enqueue({
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- wire item type is a plain string; a runtime guard would change behavior for unknown types
    type: dec.type as SyncItemType,
    itemId: dec.id,
    operation: 'update',
    payload: '{}'
  })

  // Conflict rate per item type is the core health metric for the
  // field-merge strategy; only canvas had a conflict event before.
  trackMainLog('info', {
    scope: 'PullCoordinator',
    action: 'conflict_resolved',
    errorCode: dec.type
  })
}
