import type { z } from 'zod'
import { rpcDomains } from '@memry/rpc'
import type {
  AgentMcpDesktopApiRequest,
  AgentMcpDesktopOperation
} from '@memry/contracts/agent-mcp-channels'

import { strictDeep } from '../../../lib/strict-schema'
import { AgentToolError } from '../errors'
import { DESKTOP_INPUT_SCHEMAS } from './desktop-api-inputs'

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

function rpcParams(operation: AgentMcpDesktopOperation): readonly string[] | undefined {
  const [domain, method] = operation.split('.')
  const methods = rpcDomains.find((spec) => spec.name === domain)?.methods as
    Record<string, { params: readonly string[] }> | undefined
  return methods?.[method]?.params
}

function unrecognizedKeyPaths(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => [...issue.path, key].join('.'))
      : []
  )
}

/** Key paths in the agent's object arguments that the operation's handler would not read. */
function unknownInputKeys({ operation, args }: AgentMcpDesktopApiRequest): string[] {
  const inputs = DESKTOP_INPUT_SCHEMAS[operation]
  if (!inputs) return []
  const params = desktopOperationParams(operation)
  return params.flatMap((name, index) => {
    const schema = inputs[name]
    const value = args[index]
    if (!schema || value === null || typeof value !== 'object') return []
    const result = strictDeep(schema).safeParse(value)
    if (result.success) return []
    const paths = unrecognizedKeyPaths(result.error.issues)
    return params.length > 1 ? paths.map((path) => `${name}.${path}`) : paths
  })
}

export function desktopOperationParams(operation: AgentMcpDesktopOperation): readonly string[] {
  const handWritten = HAND_WRITTEN_PARAMS[operation]
  if (handWritten) return handWritten
  const params = rpcParams(operation)
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
