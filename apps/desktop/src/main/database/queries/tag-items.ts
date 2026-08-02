/**
 * Tag items query: notes, tasks and inbox items for a tag (including its
 * `/` descendants).
 *
 * Notes live in index.db; tasks and inbox items live in data.db — two
 * separate SQLite connections — so each source is queried against its own
 * db and the results are concatenated. See `getAllTagsWithCounts` in
 * `./tags.ts` for the same two-db idiom.
 *
 * @module db/queries/tag-items
 */

import { eq, inArray, like, or, type Column, type SQL } from 'drizzle-orm'
import { noteCache, noteTags } from '@memry/db-schema/schema/notes-cache'
import { tasks } from '@memry/db-schema/schema/tasks'
import { taskTags } from '@memry/db-schema/schema/task-relations'
import { projects } from '@memry/db-schema/schema/projects'
import { inboxItems, inboxItemTags } from '@memry/db-schema/schema/inbox'
import type { DataDb, IndexDb } from '../types'

export interface TagItem {
  id: string
  kind: 'note' | 'task' | 'inbox'
  title: string
  emoji: string | null
  path: string | null
  tags: string[]
  container: string | null
  created: string
  modified: string
}

/**
 * Exact-or-descendant predicate: `tag = ? OR tag LIKE ? || '/%'`.
 * Never a bare `LIKE 'work%'` — that would also match `workshop`.
 */
function tagMatches<TColumn extends Column>(column: TColumn, normalizedTag: string): SQL {
  return or(eq(column, normalizedTag), like(column, `${normalizedTag}/%`))!
}

function folderOf(path: string): string | null {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? null : path.slice(0, idx)
}

function listNoteItems(indexDb: IndexDb, normalizedTag: string): TagItem[] {
  const matchingIds = [
    ...new Set(
      indexDb
        .select({ noteId: noteTags.noteId })
        .from(noteTags)
        .where(tagMatches(noteTags.tag, normalizedTag))
        .all()
        .map((r) => r.noteId)
    )
  ]
  if (matchingIds.length === 0) return []

  const notes = indexDb
    .select({
      id: noteCache.id,
      title: noteCache.title,
      emoji: noteCache.emoji,
      path: noteCache.path,
      createdAt: noteCache.createdAt,
      modifiedAt: noteCache.modifiedAt
    })
    .from(noteCache)
    .where(inArray(noteCache.id, matchingIds))
    .all()

  const allTagRows = indexDb
    .select({ noteId: noteTags.noteId, tag: noteTags.tag })
    .from(noteTags)
    .where(inArray(noteTags.noteId, matchingIds))
    .all()

  const tagsByNoteId = new Map<string, string[]>()
  for (const row of allTagRows) {
    const arr = tagsByNoteId.get(row.noteId) ?? []
    arr.push(row.tag)
    tagsByNoteId.set(row.noteId, arr)
  }

  return notes.map((note) => ({
    id: note.id,
    kind: 'note' as const,
    title: note.title,
    emoji: note.emoji ?? null,
    path: note.path,
    tags: tagsByNoteId.get(note.id) ?? [],
    container: folderOf(note.path),
    created: note.createdAt,
    modified: note.modifiedAt
  }))
}

function listTaskItems(dataDb: DataDb, normalizedTag: string): TagItem[] {
  const matchingIds = [
    ...new Set(
      dataDb
        .select({ taskId: taskTags.taskId })
        .from(taskTags)
        .where(tagMatches(taskTags.tag, normalizedTag))
        .all()
        .map((r) => r.taskId)
    )
  ]
  if (matchingIds.length === 0) return []

  const rows = dataDb
    .select({
      id: tasks.id,
      title: tasks.title,
      createdAt: tasks.createdAt,
      modifiedAt: tasks.modifiedAt,
      projectName: projects.name
    })
    .from(tasks)
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .where(inArray(tasks.id, matchingIds))
    .all()

  const allTagRows = dataDb
    .select({ taskId: taskTags.taskId, tag: taskTags.tag })
    .from(taskTags)
    .where(inArray(taskTags.taskId, matchingIds))
    .all()

  const tagsByTaskId = new Map<string, string[]>()
  for (const row of allTagRows) {
    const arr = tagsByTaskId.get(row.taskId) ?? []
    arr.push(row.tag)
    tagsByTaskId.set(row.taskId, arr)
  }

  return rows.map((row) => ({
    id: row.id,
    kind: 'task' as const,
    title: row.title,
    emoji: null,
    path: null,
    tags: tagsByTaskId.get(row.id) ?? [],
    container: row.projectName ?? null,
    created: row.createdAt,
    modified: row.modifiedAt
  }))
}

function listInboxItemsForTag(dataDb: DataDb, normalizedTag: string): TagItem[] {
  const matchingIds = [
    ...new Set(
      dataDb
        .select({ itemId: inboxItemTags.itemId })
        .from(inboxItemTags)
        .where(tagMatches(inboxItemTags.tag, normalizedTag))
        .all()
        .map((r) => r.itemId)
    )
  ]
  if (matchingIds.length === 0) return []

  const rows = dataDb
    .select({
      id: inboxItems.id,
      title: inboxItems.title,
      createdAt: inboxItems.createdAt,
      modifiedAt: inboxItems.modifiedAt
    })
    .from(inboxItems)
    .where(inArray(inboxItems.id, matchingIds))
    .all()

  const allTagRows = dataDb
    .select({ itemId: inboxItemTags.itemId, tag: inboxItemTags.tag })
    .from(inboxItemTags)
    .where(inArray(inboxItemTags.itemId, matchingIds))
    .all()

  const tagsByItemId = new Map<string, string[]>()
  for (const row of allTagRows) {
    const arr = tagsByItemId.get(row.itemId) ?? []
    arr.push(row.tag)
    tagsByItemId.set(row.itemId, arr)
  }

  return rows.map((row) => ({
    id: row.id,
    kind: 'inbox' as const,
    title: row.title,
    emoji: null,
    path: null,
    tags: tagsByItemId.get(row.id) ?? [],
    container: null,
    created: row.createdAt,
    modified: row.modifiedAt
  }))
}

/**
 * List notes, tasks and inbox items tagged with `tag` or any of its `/`
 * descendants (e.g. `work` also matches `work/meetings`, never `workshop`).
 */
export function listTagItems(indexDb: IndexDb, dataDb: DataDb, tag: string): TagItem[] {
  const normalizedTag = tag.toLowerCase().trim()

  return [
    ...listNoteItems(indexDb, normalizedTag),
    ...listTaskItems(dataDb, normalizedTag),
    ...listInboxItemsForTag(dataDb, normalizedTag)
  ]
}
