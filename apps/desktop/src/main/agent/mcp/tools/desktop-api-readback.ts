import type {
  AgentMcpDesktopApiRequest,
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

function call(operation: AgentMcpDesktopReadOperation, args: unknown[] = []): Readback['request'] {
  return { operation, args }
}

function read(operation: AgentMcpDesktopReadOperation, args: unknown[] = []): Readback {
  return { request: call(operation, args), select: whole }
}

/** Read a list and pick one entry; `listKey` names the field holding the list, if any. */
function findIn(
  request: Readback['request'],
  listKey: string | null,
  key: string,
  matches: (entryValue: unknown) => boolean
): Readback {
  return {
    request,
    select: (data) => {
      const list = listKey === null ? data : field(data, listKey)
      return (Array.isArray(list) ? list : []).find((entry) => matches(field(entry, key))) ?? null
    }
  }
}

const equals = (value: unknown) => (entryValue: unknown) => entryValue === value

// The tag writers match a name trimmed and case-insensitively; so does the read-back.
const tagName = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)

const propertyDefinition = (args: Args) =>
  findIn(call('notes.getPropertyDefinitions'), null, 'name', equals(args[0]))
const tag = (name: unknown) =>
  findIn(call('tags.getAllWithCounts'), 'tags', 'name', (entry) => tagName(entry) === tagName(name))
// Folder paths are vault-relative; a call may add a leading or trailing slash.
const folderPath = (value: unknown) =>
  typeof value === 'string' ? value.replace(/^\/+|\/+$/g, '') : value
const folder = (path: unknown) =>
  findIn(call('notes.getFolders'), null, 'path', (entry) => folderPath(entry) === folderPath(path))
const inboxItem = (args: Args) => read('inbox.get', [args[0]])

/** The note's entry in the tag's pinned or unpinned list. */
function tagNote(input: unknown): Readback {
  const noteId = field(input, 'noteId')
  return {
    request: call('tags.getNotesByTag', [{ tag: field(input, 'tag') }]),
    select: (data) => {
      const notes = ['pinnedNotes', 'unpinnedNotes'].flatMap((key) => {
        const list = field(data, key)
        return Array.isArray(list) ? list : []
      })
      return notes.find((note) => field(note, 'id') === noteId) ?? null
    }
  }
}

const settings = (operation: AgentMcpDesktopReadOperation) => () => read(operation)

/**
 * Writes whose reply carries no record get one read after the write lands, so
 * the agent sees what was stored. Writes that already return their record
 * (create/update of notes, tasks, templates, reminders, events...), deletes,
 * reorders and bulk calls are not listed: a delete leaves nothing to read, and
 * the others report counts or positions the agent sent. agent-mcp.md names the
 * few others that reply without `stored`.
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
  'tags.updateTagColor': (args) => tag(field(args[0], 'tag')),
  'tags.updateTagIcon': (args) => tag(field(args[0], 'tag')),
  'tags.renameTag': (args) => tag(field(args[0], 'newName')),
  'tags.renameCategory': (args) =>
    findIn(call('tags.listCategories'), 'categories', 'id', equals(field(args[0], 'id'))),
  'tags.mergeTag': (args) => tag(field(args[0], 'target')),
  'tags.pinNoteToTag': (args) => tagNote(args[0]),
  'tags.unpinNoteFromTag': (args) => tagNote(args[0]),
  'tags.removeTagFromNote': (args) => {
    const noteId = field(args[0], 'noteId')
    return {
      request: call('notes.get', [noteId]),
      select: (note) => (note ? { id: field(note, 'id'), tags: field(note, 'tags') } : null)
    }
  },
  'folderView.setConfig': (args) => read('folderView.getConfig', [args[0]]),
  'folderView.setView': (args) =>
    findIn(call('folderView.getViews', [args[0]]), 'views', 'name', equals(field(args[1], 'name'))),
  'notes.createFolder': (args) => folder(args[0]),
  'notes.renameFolder': (args) => folder(args[1]),
  'inbox.undoFile': inboxItem,
  'inbox.undoArchive': inboxItem,
  'properties.rename': (args) => read('properties.get', [args[0]]),
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

export async function keepLegacyPropertyKeys(
  args: Args,
  readCurrent: (entityId: string) => Promise<Record<string, unknown>>
): Promise<Args> {
  const [entityId, next, ...rest] = args
  if (typeof entityId !== 'string' || !next || typeof next !== 'object' || Array.isArray(next)) {
    return args
  }
  const current = await readCurrent(entityId)
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

/**
 * The write has landed when its read-back fails; reporting it as failed would
 * invite a retry that writes it twice.
 */
export function readBackFailedWarning(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error)
  return (
    `The write landed, but reading it back failed (${reason}). ` +
    'Read the record to see what was stored.'
  )
}

function isFailedReply(data: unknown): boolean {
  return Boolean(data && typeof data === 'object' && 'success' in data && data.success === false)
}

/** Run a desktop write and add the record a read returns after it, when the reply has none. */
export async function writeAndReadBack(
  input: { operation: AgentMcpDesktopWriteOperation; args: unknown[] },
  invoke: (request: AgentMcpDesktopApiRequest) => Promise<unknown>,
  currentProperties: (entityId: string) => Promise<Record<string, unknown>>
): Promise<unknown> {
  const request =
    input.operation === 'properties.set'
      ? { ...input, args: await keepLegacyPropertyKeys(input.args, currentProperties) }
      : input
  const data = await invoke(request)
  const readback = desktopWriteReadback(request)
  if (!readback || isFailedReply(data)) return data
  const reply = data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data }
  try {
    return { ...reply, stored: readback.select(await invoke(readback.request)) }
  } catch (error) {
    return { ...reply, warnings: [readBackFailedWarning(error)] }
  }
}
