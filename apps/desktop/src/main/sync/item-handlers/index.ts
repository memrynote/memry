import type { SyncItemType } from '@memry/contracts/sync-api'
import type { SyncItemHandler } from './types'
import { taskHandler } from './task-handler'
import { inboxHandler } from './inbox-handler'
import { filterHandler } from './filter-handler'
import { projectHandler } from './project-handler'
import { settingsHandler } from './settings-handler'
import { noteHandler } from './note-handler'
import { journalHandler } from './journal-handler'
import { tagDefinitionHandler } from './tag-definition-handler'

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
  ['tag_definition', tagDefinitionHandler]
])

export function getHandler(type: SyncItemType): SyncItemHandler | undefined {
  return handlers.get(type)
}

export function getAllHandlers(): SyncItemHandler[] {
  return Array.from(handlers.values())
}
