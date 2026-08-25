import { createLogger } from '../../lib/logger'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import type { ConflictDetectedEvent } from '@memry/contracts/ipc-events'
import type { SyncItemType } from '@memry/contracts/sync-api'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { getRemoteSyncAdapter } from '../item-handlers'
import { trackMainLog } from '../../telemetry/diagnostics'

const log = createLogger('PullCoordinator')

/**
 * Remote-vs-local conflict surfacing for the pull path, extracted from
 * PullCoordinator: emit the two versions to the renderer and re-queue the item
 * so the merged state pushes back.
 */
export function reportConflictAndRequeue(args: {
  dec: {
    id: string
    type: string
    content: string
    clock?: Record<string, number>
  }
  emitToRenderer: (channel: string, payload: ConflictDetectedEvent) => void
  queue: {
    enqueue: (item: {
      type: SyncItemType
      itemId: string
      operation: 'update'
      payload: string
    }) => void
  }
  localVersion: Record<string, unknown>
}): void {
  const { dec, emitToRenderer, queue, localVersion } = args

  let remoteVersion: Record<string, unknown> = {}
  try {
    const parsedRemote = JSON.parse(dec.content) as unknown
    if (parsedRemote && typeof parsedRemote === 'object' && !Array.isArray(parsedRemote)) {
      remoteVersion = parsedRemote as Record<string, unknown>
    }
    if (dec.clock) remoteVersion.clock = dec.clock
  } catch {
    log.warn('Failed to parse remote content for conflict event', { itemId: dec.id })
  }

  emitToRenderer(EVENT_CHANNELS.CONFLICT_DETECTED, {
    itemId: dec.id,
    type: dec.type,
    localVersion,
    remoteVersion,
    localClock: (localVersion.clock as Record<string, number>) ?? undefined,
    remoteClock: dec.clock ?? undefined
  })

  queue.enqueue({
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

/** Best-effort read of the local row for a conflict event; never throws. */
export function fetchLocalItemSnapshot(
  adapters:
    | {
        getRemote: (
          type: SyncItemType
        ) =>
          | { fetchLocal?: (db: DrizzleDb, id: string) => Record<string, unknown> | undefined }
          | undefined
      }
    | undefined,
  db: DrizzleDb,
  itemId: string,
  type: string
): Record<string, unknown> {
  try {
    const adapter =
      adapters?.getRemote(type as SyncItemType) ?? getRemoteSyncAdapter(type as SyncItemType)
    return adapter?.fetchLocal?.(db, itemId) ?? {}
  } catch {
    log.warn('Failed to fetch local item for conflict', { itemId, type })
    return {}
  }
}
