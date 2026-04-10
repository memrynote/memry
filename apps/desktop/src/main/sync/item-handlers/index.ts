import type { SyncItemType } from '@memry/contracts/sync-api'
import type { RemoteSyncAdapter } from '@memry/sync-core'
import type { SyncItemHandler, DrizzleDb, EmitToWindows } from './types'
import type { SyncQueueManager } from '../queue'
import { taskHandler } from './task-handler'
import { inboxHandler } from './inbox-handler'
import { filterHandler } from './filter-handler'
import { projectHandler } from './project-handler'
import { settingsHandler } from './settings-handler'
import { noteHandler } from './note-handler'
import { journalHandler } from './journal-handler'
import { tagDefinitionHandler } from './tag-definition-handler'
import { folderConfigHandler } from './folder-config-handler'

export type { SyncItemHandler, ApplyContext, ApplyResult, DrizzleDb, EmitToWindows } from './types'
export { resolveClockConflict } from './types'

const handlers = new Map<SyncItemType, SyncItemHandler>([
  ['task', taskHandler],
  ['inbox', inboxHandler],
  ['filter', filterHandler],
  ['project', projectHandler],
  ['settings', settingsHandler],
  ['note', noteHandler],
  ['journal', journalHandler],
  ['tag_definition', tagDefinitionHandler],
  ['folder_config', folderConfigHandler]
])

type DesktopRemoteSyncAdapter = RemoteSyncAdapter<DrizzleDb, EmitToWindows>

function toRemoteSyncAdapter(handler: SyncItemHandler): DesktopRemoteSyncAdapter {
  return {
    type: handler.type,
    schema: handler.schema,
    applyRemoteMutation: ({ db, emit, itemId, operation, data, clock }) => {
      const ctx = { db, emit }
      if (operation === 'delete') {
        return handler.applyDelete(ctx, itemId, clock)
      }
      if (data === undefined) return 'parse_error'
      return handler.applyUpsert(ctx, itemId, data, clock ?? {})
    },
    fetchLocal: handler.fetchLocal ? (db, itemId) => handler.fetchLocal?.(db, itemId) : undefined,
    seedUnclocked: handler.seedUnclocked
      ? (db, deviceId, queue) =>
          handler.seedUnclocked?.(db, deviceId, queue as SyncQueueManager) ?? 0
      : undefined,
    buildPushPayload: handler.buildPushPayload
      ? (db, itemId, deviceId, operation) =>
          handler.buildPushPayload?.(db, itemId, deviceId, operation) ?? null
      : undefined,
    markPushSynced: handler.markPushSynced
      ? (db, itemId) => handler.markPushSynced?.(db, itemId)
      : undefined
  }
}

export function getHandler(type: SyncItemType): SyncItemHandler | undefined {
  return handlers.get(type)
}

export function getAllHandlers(): SyncItemHandler[] {
  return Array.from(handlers.values())
}

export function getRemoteSyncAdapter(type: SyncItemType): DesktopRemoteSyncAdapter | undefined {
  const handler = getHandler(type)
  return handler ? toRemoteSyncAdapter(handler) : undefined
}

export function getAllRemoteSyncAdapters(): DesktopRemoteSyncAdapter[] {
  return getAllHandlers().map((handler) => toRemoteSyncAdapter(handler))
}
