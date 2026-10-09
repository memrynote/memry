import { EVENT_CHANNELS, type InitialSyncProgressEvent } from '@memry/contracts/ipc-events'
import type { RecordChangesResponse } from '@memry/contracts/sync-api'
import type { SyncContext } from './sync-context'

/** During a full sync, tells the renderer how many records the pull has applied. */
export function emitInitialSyncProgress(
  ctx: SyncContext,
  changes: RecordChangesResponse,
  pulledCount: number
): void {
  if (!ctx.fullSyncActive) return

  const estimatedTotal = changes.hasMore ? pulledCount + ctx.options.pullPageLimit : pulledCount
  ctx.deps.emitToRenderer(EVENT_CHANNELS.INITIAL_SYNC_PROGRESS, {
    phase: 'notes',
    processedItems: pulledCount,
    totalItems: estimatedTotal
  } satisfies InitialSyncProgressEvent)
}
