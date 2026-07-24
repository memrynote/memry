import type { AgentSourceKind, AgentSourceRef } from '@memry/contracts/ipc-agent'

type JsonRecord = Record<string, unknown>
type SourceRefMeta = {
  icon?: string | null
  itemType?: string | null
  visualType?: string | null
}

export function extractAgentSourceRefs(
  toolName: string,
  args: unknown,
  result: unknown
): AgentSourceRef[] {
  const normalizedToolName = normalizeToolName(toolName)
  const resultPayloads = toolResultPayloads(result)
  const refs: AgentSourceRef[] = []
  for (const payload of resultPayloads) refs.push(...extractExistingRefs(payload))

  switch (normalizedToolName) {
    case 'vault_search_notes':
      refs.push(...refsFromPayloadArrays(resultPayloads, noteRefFromRecord))
      break
    case 'vault_read_note':
    case 'vault_get_current_note':
      refs.push(...maybeRefFromPayloads(resultPayloads, noteRefFromRecord))
      break
    case 'vault_list_folder':
      refs.push(...refsFromPayloadArrays(resultPayloads, folderEntryRefFromRecord))
      break
    case 'vault_create_note':
    case 'vault_rename_note':
    case 'vault_update_note':
    case 'vault_add_note_tag':
    case 'vault_remove_note_tag':
    case 'vault_move_to_folder':
      refs.push(...refsFromPayloadsAndArgs(resultPayloads, args, 'note'))
      break
    case 'vault_create_folder':
    case 'vault_rename_folder':
      refs.push(...refsFromPayloadsAndArgs(resultPayloads, args, 'folder'))
      break
    case 'vault_list_tasks':
      refs.push(...refsFromPayloadArrays(resultPayloads, taskRefFromRecord))
      break
    case 'vault_get_task':
      refs.push(...maybeRefFromPayloads(resultPayloads, taskRefFromRecord))
      break
    case 'vault_create_task':
    case 'vault_update_task':
    case 'vault_complete_task':
    case 'vault_uncomplete_task':
    case 'vault_archive_task':
    case 'vault_unarchive_task':
    case 'vault_move_task':
    case 'vault_duplicate_task':
    case 'vault_convert_task_to_subtask':
    case 'vault_convert_subtask_to_task':
    case 'vault_add_task_tag':
    case 'vault_remove_task_tag':
      refs.push(...refsFromPayloadsAndArgs(resultPayloads, args, 'task'))
      break
    case 'vault_list_projects':
      refs.push(...refsFromPayloadArrays(resultPayloads, projectRefFromRecord))
      break
    case 'vault_get_project':
      refs.push(...maybeRefFromPayloads(resultPayloads, projectRefFromRecord))
      break
    case 'vault_create_project':
    case 'vault_update_project':
    case 'vault_archive_project':
      refs.push(...refsFromPayloadsAndArgs(resultPayloads, args, 'project'))
      break
    case 'vault_get_journal_entry':
      refs.push(...maybeRefFromPayloads(resultPayloads, journalRefFromRecord))
      break
    case 'vault_list_journal_entries':
      refs.push(...refsFromPayloadArrays(resultPayloads, journalRefFromRecord))
      break
    case 'vault_create_journal_entry':
    case 'vault_update_journal_entry':
      refs.push(...refsFromPayloadsAndArgs(resultPayloads, args, 'journal'))
      break
    case 'vault_list_inbox_items':
      refs.push(...refsFromPayloadArrays(resultPayloads, inboxRefFromRecord))
      break
    case 'vault_get_inbox_item':
      refs.push(...maybeRefFromPayloads(resultPayloads, inboxRefFromRecord))
      break
    case 'vault_add_to_inbox':
    case 'vault_update_inbox_item':
    case 'vault_archive_inbox_item':
    case 'vault_unarchive_inbox_item':
    case 'vault_snooze_inbox_item':
    case 'vault_add_inbox_tag':
    case 'vault_remove_inbox_tag':
      refs.push(...refsFromPayloadsAndArgs(resultPayloads, args, 'inbox'))
      break
    case 'vault_desktop_read':
    case 'vault_desktop_write':
      for (const payload of resultPayloads) refs.push(...desktopOperationRefs(args, payload))
      break
  }

  return dedupeRefs(refs)
}

export function decorateToolResultWithAgentSources(
  toolName: string,
  args: unknown,
  result: unknown
): unknown {
  const sources = extractAgentSourceRefs(toolName, args, result)
  if (sources.length === 0) return result

  if (Array.isArray(result)) {
    return result.map((item) => decorateRecordWithMatchingSource(item, sources))
  }

  if (!isRecord(result)) return result

  const direct = findMatchingSource(result, sources)
  const decorated: JsonRecord = {
    ...result,
    ...(direct ? { href: direct.href, source_ref: direct } : {}),
    sources
  }

  if (Array.isArray(result.events)) {
    decorated.events = result.events.map((item) => decorateRecordWithMatchingSource(item, sources))
  }
  if (Array.isArray(result.items)) {
    decorated.items = result.items.map((item) => decorateRecordWithMatchingSource(item, sources))
  }
  if (isRecord(result.event)) {
    decorated.event = decorateRecordWithMatchingSource(result.event, sources)
  }

  return decorated
}

function normalizeToolName(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName
  return toolName.split('__').at(-1) ?? toolName
}

function extractExistingRefs(value: unknown): AgentSourceRef[] {
  const refs: AgentSourceRef[] = []
  walk(value, (item) => {
    if (!isRecord(item.source_ref)) return
    const ref = parseSourceRef(item.source_ref)
    if (ref) refs.push(ref)
  })
  return refs
}

function walk(value: unknown, visit: (record: JsonRecord) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit)
    return
  }
  if (!isRecord(value)) return
  visit(value)
  for (const nested of Object.values(value)) walk(nested, visit)
}

function refsFromArray(
  value: unknown,
  factory: (record: JsonRecord) => AgentSourceRef | null
): AgentSourceRef[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => maybeRef(item, factory))
}

function refsFromPayloadArrays(
  payloads: unknown[],
  factory: (record: JsonRecord) => AgentSourceRef | null
): AgentSourceRef[] {
  return payloads.flatMap((payload) => refsFromArray(payload, factory))
}

function maybeRef(
  value: unknown,
  factory: (record: JsonRecord) => AgentSourceRef | null
): AgentSourceRef[] {
  if (!isRecord(value)) return []
  const ref = factory(value)
  return ref ? [ref] : []
}

function maybeRefFromPayloads(
  payloads: unknown[],
  factory: (record: JsonRecord) => AgentSourceRef | null
): AgentSourceRef[] {
  return payloads.flatMap((payload) => maybeRef(payload, factory))
}

function refsFromPayloadsAndArgs(
  payloads: unknown[],
  args: unknown,
  kind: AgentSourceKind
): AgentSourceRef[] {
  return payloads.flatMap((payload) => maybeRefFromResultAndArgs(payload, args, kind))
}

function maybeRefFromResultAndArgs(
  result: unknown,
  args: unknown,
  kind: AgentSourceKind
): AgentSourceRef[] {
  const resultRecord = isRecord(result) ? result : {}
  const argsRecord = isRecord(args) ? args : {}
  const id = firstString(resultRecord.id, argsRecord.id, argsRecord.task_id, argsRecord.path)
  const date = firstString(resultRecord.date, argsRecord.date)
  const title = firstString(
    resultRecord.title,
    resultRecord.name,
    argsRecord.title,
    argsRecord.name,
    argsRecord.new_path,
    argsRecord.path,
    date
  )

  if (kind === 'journal') {
    if (!date) return []
    return [buildRef('journal', date, title ?? `Journal ${date}`)]
  }

  if (kind === 'folder') {
    const path = firstString(resultRecord.path, argsRecord.new_path, argsRecord.path, id)
    if (!path) return []
    return [buildRef('folder', path, title ?? path)]
  }

  if (!id) return []
  return [buildRef(kind, id, title ?? fallbackTitle(kind, id))]
}

function noteRefFromRecord(record: JsonRecord): AgentSourceRef | null {
  const id = firstString(record.id)
  const title = firstString(record.title, record.name)
  if (!id || !title) return null
  return buildRef('note', id, title, { icon: noteIconFromRecord(record) })
}

function taskRefFromRecord(record: JsonRecord): AgentSourceRef | null {
  const id = firstString(record.id, record.sourceId)
  const title = firstString(record.title, record.name)
  if (!id || !title) return null
  return buildRef('task', id, title, { visualType: firstString(record.visualType) })
}

function inboxRefFromRecord(record: JsonRecord): AgentSourceRef | null {
  const id = firstString(record.id, record.sourceId)
  const title = firstString(record.title, record.name)
  if (!id || !title) return null
  const metadata: JsonRecord = isRecord(record.metadata) ? record.metadata : {}
  const directType = firstString(record.itemType, record.item_type, metadata.itemType)
  const recordType = firstString(record.type)
  const itemType = directType ?? (recordType && recordType !== 'inbox' ? recordType : null)
  return buildRef('inbox', id, title, {
    itemType,
    visualType:
      firstString(
        record.visualType,
        record.visual_type,
        metadata.visualType,
        metadata.visual_type
      ) ?? inboxVisualTypeFromRecord(record, metadata, itemType)
  })
}

function projectRefFromRecord(record: JsonRecord): AgentSourceRef | null {
  const id = firstString(record.id)
  const title = firstString(record.name, record.title)
  if (!id || !title) return null
  return buildRef('project', id, title, { icon: firstString(record.icon) })
}

function folderEntryRefFromRecord(record: JsonRecord): AgentSourceRef | null {
  const kind = firstString(record.kind)
  if (kind === 'note') return noteRefFromRecord({ ...record, title: record.name })
  if (kind !== 'folder') return null
  const path = firstString(record.path, record.id)
  const title = firstString(record.name, record.path)
  if (!path || !title) return null
  return buildRef('folder', path, title)
}

function journalRefFromRecord(record: JsonRecord): AgentSourceRef | null {
  const date = firstString(record.date, record.id)
  if (!date) return null
  return buildRef('journal', date, firstString(record.title) ?? `Journal ${date}`)
}

function desktopOperationRefs(args: unknown, result: unknown): AgentSourceRef[] {
  const argRecord = isRecord(args) ? args : {}
  const operation = firstString(argRecord.operation)
  if (!operation?.startsWith('calendar.')) return []

  const operationArgs = Array.isArray(argRecord.args) ? argRecord.args : []
  const firstArg = isRecord(operationArgs[0]) ? operationArgs[0] : {}

  if (operation === 'calendar.getRange' && isRecord(result) && Array.isArray(result.items)) {
    return result.items.flatMap((item) => {
      if (!isRecord(item)) return []
      if (item.sourceType === 'event') return maybeRef(item, calendarProjectionRefFromRecord)
      if (item.sourceType === 'task') return maybeRef(item, taskRefFromRecord)
      if (item.sourceType === 'inbox_snooze') return maybeRef(item, inboxRefFromRecord)
      return []
    })
  }

  if (operation === 'calendar.listEvents' && isRecord(result) && Array.isArray(result.events)) {
    return refsFromArray(result.events, calendarEventRefFromRecord)
  }

  if (operation === 'calendar.getEvent') {
    return maybeRef(result, calendarEventRefFromRecord)
  }

  if (
    (operation === 'calendar.createEvent' || operation === 'calendar.updateEvent') &&
    isRecord(result)
  ) {
    if (isRecord(result.event)) return maybeRef(result.event, calendarEventRefFromRecord)
    const id = firstString(result.eventId, firstArg.id)
    const title = firstString(result.title, firstArg.title)
    const startAt = firstString(result.startAt, firstArg.startAt)
    if (!id || !title || !startAt) return []
    return [buildCalendarEventRef(id, title, dateFromIso(startAt), firstString(result.visualType))]
  }

  return []
}

function calendarEventRefFromRecord(record: JsonRecord): AgentSourceRef | null {
  const id = firstString(record.id, record.eventId)
  const title = firstString(record.title)
  const startAt = firstString(record.startAt)
  if (!id || !title || !startAt) return null
  return buildCalendarEventRef(id, title, dateFromIso(startAt), firstString(record.visualType))
}

function calendarProjectionRefFromRecord(record: JsonRecord): AgentSourceRef | null {
  const id = firstString(record.sourceId, record.id)
  const title = firstString(record.title)
  const startAt = firstString(record.startAt)
  if (!id || !title || !startAt) return null
  return buildCalendarEventRef(id, title, dateFromIso(startAt), firstString(record.visualType))
}

function buildRef(
  kind: AgentSourceKind,
  id: string,
  title: string,
  meta: SourceRefMeta = {}
): AgentSourceRef {
  return {
    kind,
    id,
    title,
    href: `memry://${hrefPathForKind(kind, id)}`,
    ...sourceMeta(meta)
  }
}

function buildCalendarEventRef(
  id: string,
  title: string,
  date: string,
  visualType?: string | null
): AgentSourceRef {
  return {
    kind: 'calendar_event',
    id,
    title,
    href: `memry://calendar/event/${encodeURIComponent(id)}?date=${encodeURIComponent(date)}`,
    ...sourceMeta({ visualType })
  }
}

function hrefPathForKind(kind: AgentSourceKind, id: string): string {
  const encoded = encodeURIComponent(id)
  if (kind === 'calendar_event') return `calendar/event/${encoded}`
  return `${kind}/${encoded}`
}

function fallbackTitle(kind: AgentSourceKind, id: string): string {
  return `${kind.replace('_', ' ')} ${id}`
}

function dateFromIso(value: string): string {
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value)
  return match?.[0] ?? value
}

function decorateRecordWithMatchingSource(item: unknown, sources: AgentSourceRef[]): unknown {
  if (!isRecord(item)) return item
  const source = findMatchingSource(item, sources)
  if (!source) return item
  return { ...item, href: source.href, source_ref: source }
}

function findMatchingSource(record: JsonRecord, sources: AgentSourceRef[]): AgentSourceRef | null {
  const id = firstString(record.id, record.sourceId, record.path, record.date)
  if (!id) return null
  return sources.find((source) => source.id === id) ?? null
}

function parseSourceRef(value: JsonRecord): AgentSourceRef | null {
  const kind = firstString(value.kind)
  const id = firstString(value.id)
  const title = firstString(value.title)
  const href = firstString(value.href)
  if (!kind || !id || !title || !href) return null
  if (!isAgentSourceKind(kind)) return null
  return {
    kind,
    id,
    title,
    href,
    ...sourceMeta({
      icon: firstString(value.icon),
      itemType: firstString(value.itemType),
      visualType: firstString(value.visualType)
    })
  }
}

function isAgentSourceKind(kind: string): kind is AgentSourceKind {
  return (
    kind === 'note' ||
    kind === 'task' ||
    kind === 'inbox' ||
    kind === 'journal' ||
    kind === 'calendar_event' ||
    kind === 'project' ||
    kind === 'folder'
  )
}

function dedupeRefs(refs: AgentSourceRef[]): AgentSourceRef[] {
  const seen = new Set<string>()
  const result: AgentSourceRef[] = []
  for (const ref of refs) {
    if (seen.has(ref.href)) continue
    seen.add(ref.href)
    result.push(ref)
  }
  return result
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function noteIconFromRecord(record: JsonRecord): string | null {
  const metadata: JsonRecord = isRecord(record.metadata) ? record.metadata : {}
  const frontmatter: JsonRecord = isRecord(record.frontmatter) ? record.frontmatter : {}
  return firstString(record.icon, record.emoji, metadata.emoji, frontmatter.emoji, frontmatter.icon)
}

function sourceMeta(
  meta: SourceRefMeta
): Partial<Pick<AgentSourceRef, 'icon' | 'itemType' | 'visualType'>> {
  return {
    ...(meta.icon ? { icon: meta.icon } : {}),
    ...(meta.itemType ? { itemType: meta.itemType } : {}),
    ...(meta.visualType ? { visualType: meta.visualType } : {})
  }
}

function toolResultPayloads(result: unknown): unknown[] {
  const payloads: unknown[] = [result]
  if (!isRecord(result)) return payloads

  if ('structuredContent' in result) {
    const structuredContent = result.structuredContent
    payloads.push(structuredContent)
    if (isRecord(structuredContent) && 'result' in structuredContent) {
      payloads.push(structuredContent.result)
    }
  }

  const content = result.content
  if (Array.isArray(content)) {
    for (const entry of content) {
      if (!isRecord(entry) || typeof entry.text !== 'string') continue
      const parsed = parseJson(entry.text)
      if (parsed !== undefined) payloads.push(parsed)
    }
  }

  return payloads
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function inboxVisualTypeFromRecord(
  record: JsonRecord,
  metadata: JsonRecord,
  itemType: string | null
): string | null {
  if (itemType === 'clip') return 'quote'

  const platform = firstString(metadata.platform)
  if (itemType === 'social' && platform === 'twitter') return 'twitter'

  const sourceUrl = firstString(
    record.sourceUrl,
    record.source_url,
    record.source,
    metadata.postUrl
  )
  if ((itemType === 'social' || itemType === 'link') && sourceUrl && isTwitterUrl(sourceUrl)) {
    return 'twitter'
  }

  return itemType === 'social' ? 'social' : null
}

function isTwitterUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase()
    return (
      host === 'x.com' ||
      host.endsWith('.x.com') ||
      host === 'twitter.com' ||
      host.endsWith('.twitter.com')
    )
  } catch {
    return false
  }
}
