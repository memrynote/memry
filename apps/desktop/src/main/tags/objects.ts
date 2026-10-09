/**
 * Read-only object queries for tags with fields.
 *
 * Membership (decisions.md "Object membership"): a note is an object of tag T
 * when T, or a tag that extends T, is in its header (`note_tags.in_header = 1`)
 * and the note is markdown and not a journal entry. The `/` hierarchy never
 * confers membership. A task's tags all count as header tags. Everything else
 * that carries T (inline-only notes, journals, binaries, `T/child` rows, inbox
 * items) lists under "Mentioned in", so no tagged item disappears.
 *
 * Plain tags (no fields, own or inherited) keep today's tag page untouched.
 */

import type { NoteWithProperties, ViewConfig, ViewScope } from '@memry/contracts/folder-view-api'
import { DEFAULT_VIEW } from '@memry/contracts/folder-view-api'
import type { PropertyType } from '@memry/contracts/property-types'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import type {
  GetLinkedHereInput,
  LinkedHereGroup,
  LinkedNoteItem,
  LinkedTaskItem,
  ObjectMatch,
  SearchObjectsInput,
  SearchObjectsResponse
} from '@memry/contracts/tag-objects-api'
import { parseRelationValue } from '@memry/contracts/relation-uri'
import { plainVersionedMap, type VersionedMap } from '@memry/shared/versioned'
import { getPropertiesForNotes } from '@main/database/queries/notes/property-queries'
import { listTagItems, type TagItem } from '@main/database/queries/tag-items'
import {
  hasUnresolvedTagRows,
  listIncomingNoteRefs,
  listLinkSourceIds,
  listNoteSummaries,
  listObjectHeaderRows,
  listTagRowsForNotes,
  listTaskFieldsForTags,
  listTaskTags,
  listTasksMentioningNoteInFields,
  type NoteSummaryRow
} from '@main/database/queries/tag-objects'
import type { DataDb, IndexDb } from '../database/types'
import { descendantsOf, tagKey } from './tag-schema'

export type ResolvedTags = ReadonlyMap<string, ResolvedTag>

function fieldTagKeys(resolved: ResolvedTags): string[] {
  return [...resolved.values()].filter((tag) => tag.hasFields).map((tag) => tag.key)
}

/** `tag` and every tag that extends it, when `tag` has fields; else null (plain tag). */
function familyOf(tag: string, resolved: ResolvedTags): string[] | null {
  const key = tagKey(tag)
  if (!resolved.get(key)?.hasFields) return null
  return [key, ...descendantsOf(key, resolved)]
}

/** Root of a tag's extends chain. */
function rootOf(key: string, resolved: ResolvedTags): string {
  return resolved.get(key)?.ancestors.at(-1) ?? key
}

/** Header-ordered member tags per note, for header rows matching `tags`. */
function headerMembers(indexDb: IndexDb, tags: readonly string[]): Map<string, string[]> {
  const byNote = new Map<string, string[]>()
  for (const row of listObjectHeaderRows(indexDb, tags)) {
    const list = byNote.get(row.noteId) ?? []
    list.push(tagKey(row.tag))
    byNote.set(row.noteId, list)
  }
  return byNote
}

// ============================================================================
// Snapshot identity
// ============================================================================

/**
 * noteId -> primary object tag (first header tag with fields), objects only.
 * For `tags:get-schema-snapshot`'s `objects`.
 */
export function buildObjectIndex(
  indexDb: IndexDb,
  resolved: ResolvedTags
): { objects: Record<string, string>; complete: boolean } {
  const tags = fieldTagKeys(resolved)
  const objects: Record<string, string> = {}
  for (const [noteId, members] of headerMembers(indexDb, tags)) objects[noteId] = members[0]
  return { objects, complete: !hasUnresolvedTagRows(indexDb, tags) }
}

// ============================================================================
// Tag page rows (folder-view:list-with-properties, tag scope)
// ============================================================================

function itemPath(item: TagItem): string {
  if (item.kind === 'note') return item.path ?? ''
  return item.kind === 'task' ? `/tasks/${item.id}` : `/inbox/${item.id}`
}

/** A tag page row; `properties` is filled by the caller per row kind. */
export function tagItemToRow(
  item: TagItem,
  properties: Record<string, unknown>,
  viaTag?: string
): NoteWithProperties {
  return {
    id: item.id,
    // Tasks and inbox items have no note path; synthesise a stable one so
    // row identity and any path-keyed UI still work.
    path: itemPath(item),
    title: item.title,
    emoji: item.emoji,
    // `container` is the note's parent folder or the task's project name.
    folder: item.container ?? '',
    tags: item.tags,
    created: item.created,
    modified: item.modified,
    // TagItem carries no word count for any kind.
    wordCount: 0,
    properties,
    kind: item.kind,
    // A tagged PDF/image is a note row too; its real type keeps its metadata
    // cells read-only (#2073) and lets the canvas card it as a file (#2484).
    fileType: item.fileType,
    ...(viaTag ? { viaTag } : {})
  }
}

/**
 * Rows of a tag with fields, or null for a plain tag (the caller keeps
 * today's union). Objects carry typed note values and task `fields`.
 */
export function listFieldTagRows(
  indexDb: IndexDb,
  dataDb: DataDb,
  resolved: ResolvedTags,
  scope: Extract<ViewScope, { kind: 'tag' }>,
  rows: 'objects' | 'mentions' = 'objects'
): { rows: NoteWithProperties[]; complete: boolean } | null {
  const family = familyOf(scope.tag, resolved)
  if (!family) return null
  const self = family[0]
  const familySet = new Set(family)
  const noteMembers = headerMembers(indexDb, family)
  const taskFields = new Map<string, VersionedMap | null>()
  for (const row of listTaskFieldsForTags(dataDb, family)) taskFields.set(row.id, row.fields)

  const memberTag = (item: TagItem): string | null => {
    if (item.kind === 'inbox') return null
    const tags =
      item.kind === 'note'
        ? (noteMembers.get(item.id) ?? [])
        : taskFields.has(item.id)
          ? item.tags.map(tagKey).filter((tag) => familySet.has(tag))
          : []
    if (tags.length === 0) return null
    return tags.includes(self) ? self : tags[0]
  }

  // Objects reach the page through the tag or a descendant; mentions only
  // through the tag itself (exact or `/` child), as on a plain tag's page.
  const seen = new Set<string>()
  const picked: Array<{ item: TagItem; via: string | null }> = []
  family.forEach((tag, index) => {
    for (const item of listTagItems(indexDb, dataDb, tag, scope.andTags)) {
      const key = `${item.kind}:${item.id}`
      if (seen.has(key)) continue
      const via = memberTag(item)
      const isObject = via !== null
      if (index > 0 && !isObject) continue
      seen.add(key)
      if (isObject === (rows === 'objects')) picked.push({ item, via })
    }
  })

  const noteValues = getPropertiesForNotes(
    indexDb,
    picked.filter(({ item }) => item.kind === 'note').map(({ item }) => item.id)
  )
  return {
    rows: picked.map(({ item, via }) =>
      tagItemToRow(
        item,
        item.kind === 'note'
          ? (noteValues.get(item.id) ?? {})
          : item.kind === 'task'
            ? plainVersionedMap(taskFields.get(item.id) ?? null)
            : {},
        via && via !== self ? via : undefined
      )
    ),
    complete: !hasUnresolvedTagRows(indexDb, family)
  }
}

/** The tag table's view when none is saved: title, the effective fields in order, modified. */
export function defaultFieldTagView(tag: string, resolved: ResolvedTags): ViewConfig | null {
  const entry = resolved.get(tagKey(tag))
  if (!entry?.hasFields) return null
  return {
    ...DEFAULT_VIEW,
    columns: [
      { id: 'title', width: 250 },
      ...entry.effectiveFields.map((field) => ({ id: field.name, width: 150 })),
      { id: 'modified', width: 130 }
    ]
  }
}

/** A tag's effective fields as column types, for fields no row has filled yet. */
export function fieldColumns(
  tag: string,
  resolved: ResolvedTags
): Array<{ name: string; type: PropertyType }> {
  return (resolved.get(tagKey(tag))?.effectiveFields ?? []).map((field) => ({
    name: field.name,
    type: field.type
  }))
}

// ============================================================================
// Search (@ menu, relation picker)
// ============================================================================

/**
 * Lowercase with diacritics removed, so "ahm" finds "Ahmet" and "s" finds
 * "ş". SQLite LIKE folds ASCII only, so matching runs here. Turkish dotted and
 * dotless i both fold to "i".
 */
export function foldForSearch(text: string): string {
  return text.replace(/[İIı]/g, 'i').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
}

function matchRank(title: string, query: string): number | null {
  if (query === '') return 0
  const folded = foldForSearch(title)
  if (folded.startsWith(query)) return 0
  if (folded.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(query))) return 1
  return folded.includes(query) ? 2 : null
}

const TEXT_LIKE: ReadonlySet<PropertyType> = new Set(['text', 'url', 'select', 'status'])

function subtitleFor(
  values: Record<string, unknown>,
  entry: ResolvedTag | undefined,
  titleOf: (id: string) => string | undefined
): string[] {
  const filled = (value: unknown): value is string | number =>
    (typeof value === 'string' && value.trim() !== '') || typeof value === 'number'
  const texts: string[] = []
  let relation: string | undefined
  for (const field of entry?.effectiveFields ?? []) {
    const value = values[field.name]
    if (field.type === 'relation') {
      relation ??= parseRelationValue(value)
        .filter((ref) => ref.kind === 'note')
        .map((ref) => titleOf(ref.id))
        .find((title) => title !== undefined)
    } else if (TEXT_LIKE.has(field.type) && filled(value)) {
      texts.push(String(value))
    }
  }
  return [texts[0], relation ?? texts[1]].filter((part): part is string => part !== undefined)
}

export function searchObjects(
  indexDb: IndexDb,
  resolved: ResolvedTags,
  input: SearchObjectsInput
): SearchObjectsResponse {
  const candidates = input.tag ? (familyOf(input.tag, resolved) ?? []) : fieldTagKeys(resolved)
  const members = headerMembers(indexDb, candidates)
  const query = foldForSearch(input.query.trim())

  const ranked = listNoteSummaries(indexDb, [...members.keys()])
    .flatMap((note) => {
      const rank = matchRank(note.title, query)
      return rank === null ? [] : [{ note, rank }]
    })
    .sort((a, b) => a.rank - b.rank || b.note.modified.localeCompare(a.note.modified))
    .slice(0, input.limit)

  const values = getPropertiesForNotes(
    indexDb,
    ranked.map(({ note }) => note.id)
  )
  const refIds = [...values.values()].flatMap((record) =>
    Object.values(record).flatMap((value) =>
      parseRelationValue(value)
        .filter((ref) => ref.kind === 'note')
        .map((ref) => ref.id)
    )
  )
  const titles = new Map(listNoteSummaries(indexDb, refIds).map((note) => [note.id, note.title]))

  const matches: ObjectMatch[] = ranked.map(({ note }) => {
    const tag = members.get(note.id)![0]
    const groupTag = rootOf(tag, resolved)
    return {
      noteId: note.id,
      title: note.title,
      tag,
      groupTag,
      viaTag: tag === groupTag ? null : tag,
      subtitle: subtitleFor(values.get(note.id) ?? {}, resolved.get(tag), (id) => titles.get(id)),
      modified: note.modified
    }
  })
  return { matches, complete: !hasUnresolvedTagRows(indexDb, candidates) }
}

// ============================================================================
// Linked here (derived inverse lists)
// ============================================================================

const byNewest = (a: NoteSummaryRow, b: NoteSummaryRow): number =>
  (b.date ?? b.modified).localeCompare(a.date ?? a.modified)

const toLinkedNote = (note: NoteSummaryRow): LinkedNoteItem => ({
  noteId: note.id,
  title: note.title,
  date: note.date,
  snippet: note.snippet
})

/** First tag, in order, whose effective fields define `field` (relation fields only when asked). */
function fieldOwner(
  tags: readonly string[],
  field: string,
  resolved: ResolvedTags,
  relationOnly: boolean
): { tag: string; label: string | null } | null {
  for (const tag of tags) {
    const match = resolved
      .get(tagKey(tag))
      ?.effectiveFields.find(
        (candidate) => candidate.name === field && (!relationOnly || candidate.relation)
      )
    if (match) {
      return {
        tag: match.definedBy,
        label: match.relation?.inverse ?? resolved.get(match.definedBy)?.name ?? null
      }
    }
  }
  return null
}

export function getLinkedHere(
  indexDb: IndexDb,
  dataDb: DataDb,
  resolved: ResolvedTags,
  input: GetLinkedHereInput
): LinkedHereGroup[] {
  const uri = `memry://note/${input.noteId}`
  const filter = (field: string): string => `${field} contains "${uri}"`
  const groups: LinkedHereGroup[] = []

  // Relation fields on notes.
  const refs = listIncomingNoteRefs(indexDb, input.noteId).filter(
    (ref) => ref.sourceNoteId !== input.noteId
  )
  const sources = new Map(
    listNoteSummaries(indexDb, [...new Set(refs.map((ref) => ref.sourceNoteId))])
      .filter((note) => note.fileType === 'markdown' && note.date === null)
      .map((note) => [note.id, note])
  )
  const headerOf = new Map<string, string[]>()
  for (const row of listTagRowsForNotes(indexDb, [...sources.keys()])) {
    if (row.inHeader !== true) continue
    headerOf.set(row.noteId, [...(headerOf.get(row.noteId) ?? []), row.tag])
  }
  const relationGroups = new Map<
    string,
    { sourceTag: string; field: string; label: string; notes: NoteSummaryRow[] }
  >()
  for (const ref of refs) {
    const note = sources.get(ref.sourceNoteId)
    if (!note) continue
    const owner = fieldOwner(headerOf.get(note.id) ?? [], ref.propertyName, resolved, true)
    const sourceTag = owner?.tag ?? ''
    const key = JSON.stringify([sourceTag, ref.propertyName])
    const group = relationGroups.get(key) ?? {
      sourceTag,
      field: ref.propertyName,
      label: owner?.label ?? ref.propertyName,
      notes: []
    }
    group.notes.push(note)
    relationGroups.set(key, group)
  }
  for (const group of relationGroups.values()) {
    groups.push({
      kind: 'relation',
      sourceTag: group.sourceTag,
      field: group.field,
      label: group.label,
      total: group.notes.length,
      items: group.notes.sort(byNewest).slice(0, input.limitPerGroup).map(toLinkedNote),
      filter: filter(group.field)
    })
  }

  // Task fields. LIKE found candidates; the live map confirms them.
  const tasks = listTasksMentioningNoteInFields(dataDb, input.noteId)
  const tagsOfTask = new Map<string, string[]>()
  for (const row of listTaskTags(
    dataDb,
    tasks.map((task) => task.id)
  )) {
    tagsOfTask.set(row.taskId, [...(tagsOfTask.get(row.taskId) ?? []), row.tag])
  }
  const taskGroups = new Map<string, { tag: string; field: string; items: LinkedTaskItem[] }>()
  for (const task of tasks) {
    for (const [field, value] of Object.entries(plainVersionedMap(task.fields))) {
      if (!parseRelationValue(value).some((ref) => ref.kind === 'note' && ref.id === input.noteId))
        continue
      const tag = fieldOwner(tagsOfTask.get(task.id) ?? [], field, resolved, false)?.tag ?? ''
      const key = JSON.stringify([tag, field])
      const group = taskGroups.get(key) ?? { tag, field, items: [] }
      group.items.push({
        taskId: task.id,
        title: task.title,
        dueDate: task.dueDate,
        completed: task.completedAt !== null
      })
      taskGroups.set(key, group)
    }
  }
  for (const group of taskGroups.values()) {
    const items = group.items.sort(
      (a, b) =>
        Number(a.completed) - Number(b.completed) ||
        (a.dueDate ?? '\uffff').localeCompare(b.dueDate ?? '\uffff')
    )
    groups.push({
      kind: 'task-field',
      tag: group.tag,
      field: group.field,
      total: items.length,
      items: items.slice(0, input.limitPerGroup),
      filter: filter(group.field)
    })
  }

  // Wiki links in bodies (journals included).
  const mentions = listNoteSummaries(
    indexDb,
    listLinkSourceIds(indexDb, input.noteId).filter((id) => id !== input.noteId)
  ).sort(byNewest)
  if (mentions.length > 0) {
    groups.push({
      kind: 'mentions',
      total: mentions.length,
      items: mentions.slice(0, input.limitPerGroup).map(toLinkedNote)
    })
  }
  return groups
}
