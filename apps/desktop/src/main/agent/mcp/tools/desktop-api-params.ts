import { rpcDomains } from '@memry/rpc'
import type {
  AgentMcpDesktopApiRequest,
  AgentMcpDesktopOperation
} from '@memry/contracts/agent-mcp-channels'

import { strictDeep } from '../../../lib/strict-schema'
import { ipcInputSchema } from '../../../ipc/validate'
import { AgentToolError } from '../errors'

// Preload methods written by hand have no RPC spec to read their parameters
// from. `desktop-api-params.test.ts` pins each entry to the preload function.
const HAND_WRITTEN_PARAMS: Partial<Record<AgentMcpDesktopOperation, readonly string[]>> = {
  'journal.getEntry': ['date'],
  'journal.getHeatmap': ['year'],
  'journal.getMonthEntries': ['year', 'month'],
  'journal.getYearStats': ['year'],
  'journal.getDayContext': ['date'],
  'journal.getAllTags': [],
  'journal.getStreak': [],
  'journal.createEntry': ['input'],
  'journal.updateEntry': ['input'],
  'journal.deleteEntry': ['date'],
  'properties.get': ['entityId'],
  'properties.set': ['entityId', 'properties'],
  'properties.rename': ['entityId', 'oldName', 'newName'],
  'templates.list': [],
  'templates.get': ['id'],
  'templates.create': ['input'],
  'templates.update': ['input'],
  'templates.delete': ['id'],
  'templates.duplicate': ['id', 'newName'],
  'savedFilters.list': [],
  'savedFilters.create': ['input'],
  'savedFilters.update': ['input'],
  'savedFilters.delete': ['id'],
  'savedFilters.reorder': ['ids', 'positions'],
  'bookmarks.get': ['id'],
  'bookmarks.list': ['options'],
  'bookmarks.isBookmarked': ['input'],
  'bookmarks.listByType': ['itemType'],
  'bookmarks.getByItem': ['input'],
  'bookmarks.create': ['input'],
  'bookmarks.delete': ['id'],
  'bookmarks.toggle': ['input'],
  'bookmarks.reorder': ['bookmarkIds'],
  'bookmarks.bulkDelete': ['bookmarkIds'],
  'bookmarks.bulkCreate': ['items'],
  'tags.getNotesByTag': ['input'],
  'tags.getAllWithCounts': [],
  'tags.listCategories': [],
  'tags.pinNoteToTag': ['input'],
  'tags.unpinNoteFromTag': ['input'],
  'tags.renameTag': ['input'],
  'tags.updateTagColor': ['input'],
  'tags.deleteTag': ['tag'],
  'tags.removeTagFromNote': ['input'],
  'tags.mergeTag': ['input'],
  'tags.updateTagIcon': ['input'],
  'tags.createCategory': ['input'],
  'tags.renameCategory': ['input'],
  'tags.deleteCategory': ['input'],
  'tags.reorder': ['input'],
  'folderView.getConfig': ['folderPath'],
  'folderView.getViews': ['scope'],
  'folderView.listWithProperties': ['options'],
  'folderView.getAvailableProperties': ['scope'],
  'folderView.getFolderSuggestions': ['noteId'],
  'folderView.folderExists': ['folderPath'],
  'folderView.setConfig': ['folderPath', 'config'],
  'folderView.setView': ['scope', 'view', 'previousName'],
  'folderView.deleteView': ['scope', 'viewName'],
  'reminders.get': ['id'],
  'reminders.list': ['options'],
  'reminders.getUpcoming': ['days'],
  'reminders.getDue': [],
  'reminders.getForTarget': ['input'],
  'reminders.countPending': [],
  'reminders.create': ['input'],
  'reminders.update': ['input'],
  'reminders.delete': ['id'],
  'reminders.dismiss': ['id'],
  'reminders.snooze': ['input'],
  'reminders.bulkDismiss': ['input'],
  'search.query': ['params'],
  'search.quick': ['text', 'noteFileTypes'],
  'search.getStats': [],
  'search.getReasons': [],
  'search.getAllTags': [],
  'search.rebuildIndex': [],
  'search.addReason': ['params'],
  'search.clearReasons': [],
  'graph.getData': [],
  'graph.getLocal': ['params'],
  'homePages.list': [],
  'homePages.get': ['id'],
  'homePages.create': ['input'],
  'homePages.update': ['input'],
  'homePages.delete': ['id'],
  'homePages.reorder': ['ids'],
  'vault.getAll': [],
  'vault.getStatus': [],
  'vault.getConfig': [],
  'vault.listAccount': [],
  'vault.switch': ['vaultPath'],
  'vault.reindex': [],
  'vault.updateConfig': ['config'],
  'vault.downloadRemote': ['vaultUuid', 'parentPath'],
  // The responder still accepts the older (start, end) string pair.
  'calendar.getRange': ['inputOrStart', 'end']
}

/**
 * How the preload method turns its arguments into the IPC payload: the first
 * argument as is (`direct`), an object keyed by parameter name (`named`), or no
 * payload. Pinned to the preload functions by `desktop-api-params.test.ts`.
 */
type PayloadShape = 'none' | 'direct' | 'named'

const HAND_WRITTEN_IPC: Partial<
  Record<AgentMcpDesktopOperation, { channel: string; payload: PayloadShape }>
> = {
  'journal.getEntry': { channel: 'journal:getEntry', payload: 'named' },
  'journal.getHeatmap': { channel: 'journal:getHeatmap', payload: 'named' },
  'journal.getMonthEntries': { channel: 'journal:getMonthEntries', payload: 'named' },
  'journal.getYearStats': { channel: 'journal:getYearStats', payload: 'named' },
  'journal.getDayContext': { channel: 'journal:getDayContext', payload: 'named' },
  'journal.getAllTags': { channel: 'journal:getAllTags', payload: 'none' },
  'journal.getStreak': { channel: 'journal:getStreak', payload: 'none' },
  'properties.get': { channel: 'properties:get', payload: 'named' },
  'templates.list': { channel: 'templates:list', payload: 'none' },
  'templates.get': { channel: 'templates:get', payload: 'direct' },
  'savedFilters.list': { channel: 'saved-filters:list', payload: 'none' },
  'bookmarks.get': { channel: 'bookmarks:get', payload: 'direct' },
  'bookmarks.list': { channel: 'bookmarks:list', payload: 'direct' },
  'bookmarks.isBookmarked': { channel: 'bookmarks:is-bookmarked', payload: 'direct' },
  'bookmarks.listByType': { channel: 'bookmarks:list-by-type', payload: 'direct' },
  'bookmarks.getByItem': { channel: 'bookmarks:get-by-item', payload: 'direct' },
  'tags.getNotesByTag': { channel: 'tags:get-notes-by-tag', payload: 'direct' },
  'tags.getAllWithCounts': { channel: 'tags:get-all-with-counts', payload: 'none' },
  'tags.listCategories': { channel: 'tags:list-categories', payload: 'none' },
  'folderView.getConfig': { channel: 'folder-view:get-config', payload: 'named' },
  'folderView.getViews': { channel: 'folder-view:get-views', payload: 'named' },
  'folderView.listWithProperties': {
    channel: 'folder-view:list-with-properties',
    payload: 'direct'
  },
  'folderView.getAvailableProperties': {
    channel: 'folder-view:get-available-properties',
    payload: 'named'
  },
  'folderView.getFolderSuggestions': {
    channel: 'folder-view:get-folder-suggestions',
    payload: 'named'
  },
  'folderView.folderExists': { channel: 'folder-view:folder-exists', payload: 'direct' },
  'reminders.get': { channel: 'reminder:get', payload: 'direct' },
  'reminders.list': { channel: 'reminder:list', payload: 'direct' },
  'reminders.getUpcoming': { channel: 'reminder:get-upcoming', payload: 'direct' },
  'reminders.getDue': { channel: 'reminder:get-due', payload: 'none' },
  'reminders.getForTarget': { channel: 'reminder:get-for-target', payload: 'direct' },
  'reminders.countPending': { channel: 'reminder:count-pending', payload: 'none' },
  'search.query': { channel: 'search:query', payload: 'direct' },
  'search.quick': { channel: 'search:quick', payload: 'named' },
  'search.getStats': { channel: 'search:get-stats', payload: 'none' },
  'search.getReasons': { channel: 'search:get-reasons', payload: 'none' },
  'search.getAllTags': { channel: 'search:get-all-tags', payload: 'none' },
  'graph.getData': { channel: 'graph:get-graph-data', payload: 'none' },
  'graph.getLocal': { channel: 'graph:get-local-graph', payload: 'direct' },
  'homePages.list': { channel: 'home-pages:list', payload: 'none' },
  'homePages.get': { channel: 'home-pages:get', payload: 'direct' },
  'vault.getAll': { channel: 'vault:get-all', payload: 'none' },
  'vault.getStatus': { channel: 'vault:get-status', payload: 'none' },
  'vault.getConfig': { channel: 'vault:get-config', payload: 'none' },
  'vault.listAccount': { channel: 'vault:list-account', payload: 'none' },
  'journal.createEntry': { channel: 'journal:createEntry', payload: 'direct' },
  'journal.updateEntry': { channel: 'journal:updateEntry', payload: 'direct' },
  'journal.deleteEntry': { channel: 'journal:deleteEntry', payload: 'named' },
  'properties.set': { channel: 'properties:set', payload: 'named' },
  'properties.rename': { channel: 'properties:rename', payload: 'named' },
  'templates.create': { channel: 'templates:create', payload: 'direct' },
  'templates.update': { channel: 'templates:update', payload: 'direct' },
  'templates.delete': { channel: 'templates:delete', payload: 'direct' },
  'templates.duplicate': { channel: 'templates:duplicate', payload: 'named' },
  'savedFilters.create': { channel: 'saved-filters:create', payload: 'direct' },
  'savedFilters.update': { channel: 'saved-filters:update', payload: 'direct' },
  'savedFilters.delete': { channel: 'saved-filters:delete', payload: 'named' },
  'savedFilters.reorder': { channel: 'saved-filters:reorder', payload: 'named' },
  'bookmarks.create': { channel: 'bookmarks:create', payload: 'direct' },
  'bookmarks.delete': { channel: 'bookmarks:delete', payload: 'direct' },
  'bookmarks.toggle': { channel: 'bookmarks:toggle', payload: 'direct' },
  'bookmarks.reorder': { channel: 'bookmarks:reorder', payload: 'named' },
  'bookmarks.bulkDelete': { channel: 'bookmarks:bulk-delete', payload: 'named' },
  'bookmarks.bulkCreate': { channel: 'bookmarks:bulk-create', payload: 'named' },
  'tags.pinNoteToTag': { channel: 'tags:pin-note-to-tag', payload: 'direct' },
  'tags.unpinNoteFromTag': { channel: 'tags:unpin-note-from-tag', payload: 'direct' },
  'tags.renameTag': { channel: 'tags:rename', payload: 'direct' },
  'tags.updateTagColor': { channel: 'tags:update-color', payload: 'direct' },
  'tags.deleteTag': { channel: 'tags:delete', payload: 'direct' },
  'tags.removeTagFromNote': { channel: 'tags:remove-from-note', payload: 'direct' },
  'tags.mergeTag': { channel: 'tags:merge', payload: 'direct' },
  'tags.updateTagIcon': { channel: 'tags:update-icon', payload: 'direct' },
  'tags.createCategory': { channel: 'tags:create-category', payload: 'direct' },
  'tags.renameCategory': { channel: 'tags:rename-category', payload: 'direct' },
  'tags.deleteCategory': { channel: 'tags:delete-category', payload: 'direct' },
  'tags.reorder': { channel: 'tags:reorder', payload: 'direct' },
  'folderView.setConfig': { channel: 'folder-view:set-config', payload: 'named' },
  'folderView.setView': { channel: 'folder-view:set-view', payload: 'named' },
  'folderView.deleteView': { channel: 'folder-view:delete-view', payload: 'named' },
  'reminders.create': { channel: 'reminder:create', payload: 'direct' },
  'reminders.update': { channel: 'reminder:update', payload: 'direct' },
  'reminders.delete': { channel: 'reminder:delete', payload: 'direct' },
  'reminders.dismiss': { channel: 'reminder:dismiss', payload: 'direct' },
  'reminders.snooze': { channel: 'reminder:snooze', payload: 'direct' },
  'reminders.bulkDismiss': { channel: 'reminder:bulk-dismiss', payload: 'direct' },
  'search.rebuildIndex': { channel: 'search:rebuild-index', payload: 'none' },
  'search.addReason': { channel: 'search:add-reason', payload: 'direct' },
  'search.clearReasons': { channel: 'search:clear-reasons', payload: 'none' },
  'homePages.create': { channel: 'home-pages:create', payload: 'direct' },
  'homePages.update': { channel: 'home-pages:update', payload: 'direct' },
  'homePages.delete': { channel: 'home-pages:delete', payload: 'direct' },
  'homePages.reorder': { channel: 'home-pages:reorder', payload: 'named' },
  'vault.switch': { channel: 'vault:switch', payload: 'direct' },
  'vault.reindex': { channel: 'vault:reindex', payload: 'none' },
  'vault.updateConfig': { channel: 'vault:update-config', payload: 'direct' },
  'vault.downloadRemote': { channel: 'vault:download-remote', payload: 'named' }
}

// The responder rewrites these arguments before the call, so the payload the
// handler sees is not the one the agent sent.
const RESPONDER_NORMALIZED = new Set<AgentMcpDesktopOperation>([
  'calendar.listEvents',
  'calendar.getRange'
])

function rpcMethod(
  operation: AgentMcpDesktopOperation
): { channel: string; params: readonly string[]; invokeArgs: readonly string[] } | undefined {
  const [domain, method] = operation.split('.')
  const methods = rpcDomains.find((spec) => spec.name === domain)?.methods as
    | Record<string, { channel: string; params: readonly string[]; invokeArgs: readonly string[] }>
    | undefined
  return methods?.[method]
}

function desktopOperationIpc(
  operation: AgentMcpDesktopOperation
): { channel: string; payload: PayloadShape } | null {
  if (RESPONDER_NORMALIZED.has(operation)) return null
  const handWritten = HAND_WRITTEN_IPC[operation]
  if (handWritten) return handWritten
  const spec = rpcMethod(operation)
  if (!spec) return null
  if (spec.params.length === 0) return { channel: spec.channel, payload: 'none' }
  if (spec.invokeArgs.join(',') === spec.params.join(',')) {
    return { channel: spec.channel, payload: 'direct' }
  }
  const named = /^\{\s*([\w\s,]+?)\s*\}$/.exec(spec.invokeArgs.join(','))
  const keys = named?.[1].split(',').map((key) => key.trim())
  if (keys && keys.join(',') === spec.params.join(',')) {
    return { channel: spec.channel, payload: 'named' }
  }
  return null
}

/** Key paths in the agent's arguments that the operation's IPC handler would drop. */
function unknownInputKeys({ operation, args }: AgentMcpDesktopApiRequest): string[] {
  const ipc = desktopOperationIpc(operation)
  if (!ipc || ipc.payload === 'none') return []
  const schema = ipcInputSchema(ipc.channel)
  if (!schema) return []
  const params = desktopOperationParams(operation)
  const payload =
    ipc.payload === 'direct'
      ? args[0]
      : Object.fromEntries(params.map((name, index) => [name, args[index]]))
  const result = strictDeep(schema).safeParse(payload)
  if (result.success) return []
  return result.error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => [...issue.path, key].join('.'))
      : []
  )
}

export function desktopOperationParams(operation: AgentMcpDesktopOperation): readonly string[] {
  const handWritten = HAND_WRITTEN_PARAMS[operation]
  if (handWritten) return handWritten
  const params = rpcMethod(operation)?.params
  if (!params) {
    throw new AgentToolError(
      'INTERNAL',
      `Desktop API operation has no parameter list: ${operation}`
    )
  }
  return params
}

/**
 * The responder spreads `args` into the preload call, which drops any argument
 * past the last parameter without an error. Refuse the call instead.
 */
export function assertDesktopApiArgs({ operation, args }: AgentMcpDesktopApiRequest): void {
  const params = desktopOperationParams(operation)
  if (args.length <= params.length) {
    const unknown = unknownInputKeys({ operation, args })
    if (unknown.length === 0) return
    throw new AgentToolError(
      'VALIDATION',
      `${operation} does not take ${unknown.join(', ')}. Nothing was run.`,
      { operation, unknown }
    )
  }
  const takes =
    params.length === 0
      ? 'takes no arguments'
      : `takes ${params.length} argument${params.length === 1 ? '' : 's'} (${params.join(', ')})`
  throw new AgentToolError(
    'VALIDATION',
    `${operation} ${takes}, but this call passed ${args.length}. Nothing was run.`,
    { operation, params, received: args.length }
  )
}
