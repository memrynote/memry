import type {
  AgentMcpDesktopReadOperation,
  AgentMcpDesktopWriteOperation
} from '@memry/contracts/agent-mcp-channels'

type Args = unknown[]

interface Readback {
  request: { operation: AgentMcpDesktopReadOperation; args: unknown[] }
  select: (data: unknown) => unknown
}

const whole = (data: unknown) => data

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
}

function read(operation: AgentMcpDesktopReadOperation, args: unknown[] = []): Readback {
  return { request: { operation, args }, select: whole }
}

function findIn(operation: AgentMcpDesktopReadOperation, key: string, value: unknown): Readback {
  return {
    request: { operation, args: [] },
    select: (data) =>
      (Array.isArray(data) ? data : []).find((entry) => field(entry, key) === value) ?? null
  }
}

const propertyDefinition = (args: Args) => findIn('notes.getPropertyDefinitions', 'name', args[0])
const inboxItem = (args: Args) => read('inbox.get', [args[0]])
const settings = (operation: AgentMcpDesktopReadOperation) => () => read(operation)

/**
 * Writes whose reply carries no record get one read after the write lands, so
 * the agent sees what was stored. Writes that already return their record
 * (create/update of notes, tasks, templates, reminders, events...), deletes,
 * reorders and bulk calls are not listed: a delete leaves nothing to read, and
 * the others report counts or positions the agent sent.
 */
const READBACKS: Partial<Record<AgentMcpDesktopWriteOperation, (args: Args) => Readback>> = {
  'notes.ensurePropertyDefinition': propertyDefinition,
  'notes.addPropertyOption': propertyDefinition,
  'notes.addStatusOption': propertyDefinition,
  'notes.removePropertyOption': propertyDefinition,
  'notes.renamePropertyOption': propertyDefinition,
  'notes.updateOptionColor': propertyDefinition,
  'notes.setFolderConfig': (args) => read('notes.getFolderConfig', [args[0]]),
  'notes.setCalendarPropertyVisibility': () => read('notes.getCalendarPropertyNames'),
  'tasks.archive': (args) => read('tasks.get', [args[0]]),
  'tasks.unarchive': (args) => read('tasks.get', [args[0]]),
  'tasks.archiveProject': (args) => read('tasks.getProject', [args[0]]),
  'tasks.linkProjectItem': (args) => read('tasks.listProjectLinks', [field(args[0], 'projectId')]),
  'tasks.unlinkProjectItem': (args) =>
    read('tasks.listProjectLinks', [field(args[0], 'projectId')]),
  'tasks.setProjectLinkPinned': (args) =>
    read('tasks.listProjectLinks', [field(args[0], 'projectId')]),
  'inbox.archive': inboxItem,
  'inbox.unarchive': inboxItem,
  'inbox.addTag': inboxItem,
  'inbox.removeTag': inboxItem,
  'inbox.unsnooze': inboxItem,
  'inbox.markViewed': inboxItem,
  'inbox.linkToNote': inboxItem,
  'inbox.retryTranscription': inboxItem,
  'inbox.retryMetadata': inboxItem,
  'inbox.snooze': (args) => read('inbox.get', [field(args[0], 'itemId')]),
  'inbox.setStaleThreshold': () => read('inbox.getStaleThreshold'),
  'tags.updateTagColor': (args) => findIn('tags.getAllWithCounts', 'name', field(args[0], 'tag')),
  'tags.updateTagIcon': (args) => findIn('tags.getAllWithCounts', 'name', field(args[0], 'tag')),
  'tags.renameTag': (args) => findIn('tags.getAllWithCounts', 'name', field(args[0], 'newName')),
  'tags.renameCategory': (args) => findIn('tags.listCategories', 'id', field(args[0], 'id')),
  'settings.set': (args) => read('settings.get', [args[0]]),
  'settings.setJournalSettings': settings('settings.getJournalSettings'),
  'settings.setAISettings': settings('settings.getAISettings'),
  'settings.setVoiceTranscriptionSettings': settings('settings.getVoiceTranscriptionSettings'),
  'settings.setTabSettings': settings('settings.getTabSettings'),
  'settings.setNoteEditorSettings': settings('settings.getNoteEditorSettings'),
  'settings.setGeneralSettings': settings('settings.getGeneralSettings'),
  'settings.setEditorSettings': settings('settings.getEditorSettings'),
  'settings.setTaskSettings': settings('settings.getTaskSettings'),
  'settings.setKeyboardSettings': settings('settings.getKeyboardSettings'),
  'settings.resetKeyboardSettings': settings('settings.getKeyboardSettings'),
  'settings.setSyncSettings': settings('settings.getSyncSettings'),
  'settings.setBackupSettings': settings('settings.getBackupSettings'),
  'settings.setGraphSettings': settings('settings.getGraphSettings'),
  'settings.setCalendarSettings': settings('settings.getCalendarSettings'),
  'settings.setFeaturesSettings': settings('settings.getFeaturesSettings'),
  'settings.setInboxSettings': settings('settings.getInboxSettings')
}

export function desktopWriteReadback(input: {
  operation: AgentMcpDesktopWriteOperation
  args: unknown[]
}): Readback | null {
  return READBACKS[input.operation]?.(input.args) ?? null
}

/**
 * Notes written before the frontmatter diet carry `id`, `title`, `created` and
 * `modified` as plain properties. `properties.set` replaces the whole record,
 * so an agent that leaves them out would delete them. Keep them unless the
 * call names one: a value replaces it, `null` deletes it.
 */
const LEGACY_PROPERTY_KEYS = ['id', 'title', 'created', 'modified'] as const

export function keepLegacyPropertyKeys(
  args: Args,
  readCurrent: (entityId: string) => Record<string, unknown>
): Args {
  const [entityId, next, ...rest] = args
  if (typeof entityId !== 'string' || !next || typeof next !== 'object' || Array.isArray(next)) {
    return args
  }
  const current = readCurrent(entityId)
  const merged: Record<string, unknown> = { ...next }
  for (const key of LEGACY_PROPERTY_KEYS) {
    if (!Object.hasOwn(merged, key)) {
      if (Object.hasOwn(current, key)) merged[key] = current[key]
    } else if (merged[key] === null) {
      delete merged[key]
    }
  }
  return [entityId, merged, ...rest]
}
