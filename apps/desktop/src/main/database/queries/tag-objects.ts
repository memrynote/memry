/**
 * Index and data DB reads behind object membership (tags with fields).
 *
 * A note is an object of a tag only through a header row: `in_header = 1` on a
 * markdown, non-journal note. A NULL flag (an older build's row, not backfilled
 * yet) never counts, and callers report the read as incomplete while one
 * remains. The `note_tags.tag` column is NOCASE, so `IN` matches any casing.
 *
 * @module db/queries/tag-objects
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { noteCache, noteLinks, noteTags, propertyRefs } from '@memry/db-schema/schema/notes-cache'
import { tasks } from '@memry/db-schema/schema/tasks'
import { taskTags } from '@memry/db-schema/schema/task-relations'
import type { VersionedMap } from '@memry/shared/versioned'
import type { FileType } from '@memry/shared/file-types'
import type { DataDb, IndexDb } from '../types'

const objectRow = and(
  eq(noteTags.inHeader, true),
  eq(noteCache.fileType, 'markdown'),
  isNull(noteCache.date)
)

/** Header rows that make a note an object, in header order per note. */
export function listObjectHeaderRows(
  db: IndexDb,
  tags: readonly string[]
): Array<{ noteId: string; tag: string }> {
  if (tags.length === 0) return []
  return db
    .select({ noteId: noteTags.noteId, tag: noteTags.tag })
    .from(noteTags)
    .innerJoin(noteCache, eq(noteCache.id, noteTags.noteId))
    .where(and(objectRow, inArray(noteTags.tag, [...tags])))
    .orderBy(noteTags.noteId, noteTags.position)
    .all()
}

/** True while a row for one of `tags` has no header flag yet (pre-backfill). */
export function hasUnresolvedTagRows(db: IndexDb, tags: readonly string[]): boolean {
  if (tags.length === 0) return false
  const row = db
    .select({ noteId: noteTags.noteId })
    .from(noteTags)
    .innerJoin(noteCache, eq(noteCache.id, noteTags.noteId))
    .where(
      and(
        isNull(noteTags.inHeader),
        eq(noteCache.fileType, 'markdown'),
        inArray(noteTags.tag, [...tags])
      )
    )
    .limit(1)
    .get()
  return row !== undefined
}

export interface NoteSummaryRow {
  id: string
  title: string
  path: string
  emoji: string | null
  date: string | null
  snippet: string | null
  fileType: FileType
  created: string
  modified: string
}

export function listNoteSummaries(db: IndexDb, noteIds: readonly string[]): NoteSummaryRow[] {
  if (noteIds.length === 0) return []
  return db
    .select({
      id: noteCache.id,
      title: noteCache.title,
      path: noteCache.path,
      emoji: noteCache.emoji,
      date: noteCache.date,
      snippet: noteCache.snippet,
      fileType: noteCache.fileType,
      created: noteCache.createdAt,
      modified: noteCache.modifiedAt
    })
    .from(noteCache)
    .where(inArray(noteCache.id, [...noteIds]))
    .all()
}

/** Every tag row of the given notes, in position order. */
export function listTagRowsForNotes(
  db: IndexDb,
  noteIds: readonly string[]
): Array<{ noteId: string; tag: string; inHeader: boolean | null }> {
  if (noteIds.length === 0) return []
  return db
    .select({ noteId: noteTags.noteId, tag: noteTags.tag, inHeader: noteTags.inHeader })
    .from(noteTags)
    .where(inArray(noteTags.noteId, [...noteIds]))
    .orderBy(noteTags.noteId, noteTags.position)
    .all()
}

/** Relation properties on other notes that point at `noteId`. */
export function listIncomingNoteRefs(
  db: IndexDb,
  noteId: string
): Array<{ sourceNoteId: string; propertyName: string }> {
  return db
    .select({ sourceNoteId: propertyRefs.sourceNoteId, propertyName: propertyRefs.propertyName })
    .from(propertyRefs)
    .where(and(eq(propertyRefs.targetType, 'note'), eq(propertyRefs.targetId, noteId)))
    .all()
}

/** Notes whose body wiki-links `noteId`. */
export function listLinkSourceIds(db: IndexDb, noteId: string): string[] {
  return db
    .selectDistinct({ sourceId: noteLinks.sourceId })
    .from(noteLinks)
    .where(eq(noteLinks.targetId, noteId))
    .all()
    .map((row) => row.sourceId)
}

export interface TaskFieldRow {
  id: string
  title: string
  dueDate: string | null
  completedAt: string | null
  fields: VersionedMap | null
}

/**
 * Unarchived tasks whose stored field map mentions `memry://note/<noteId>`.
 * Only a prefilter: a tombstoned entry still holds the text, so callers
 * confirm on the plain map.
 */
export function listTasksMentioningNoteInFields(db: DataDb, noteId: string): TaskFieldRow[] {
  const escaped = noteId.replace(/[\\%_]/g, (c) => `\\${c}`)
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      dueDate: tasks.dueDate,
      completedAt: tasks.completedAt,
      fields: tasks.fields
    })
    .from(tasks)
    .where(
      and(
        isNull(tasks.archivedAt),
        sql`${tasks.fields} LIKE ${`%memry://note/${escaped}%`} ESCAPE '\\'`
      )
    )
    .all()
}

/** Tasks carrying one of `tags` exactly (case-insensitive), with their field maps. */
export function listTaskFieldsForTags(
  db: DataDb,
  tags: readonly string[]
): Array<{ id: string; tag: string; fields: VersionedMap | null }> {
  if (tags.length === 0) return []
  const lowered = tags.map((tag) => tag.toLowerCase())
  return db
    .select({ id: tasks.id, tag: taskTags.tag, fields: tasks.fields })
    .from(taskTags)
    .innerJoin(tasks, eq(tasks.id, taskTags.taskId))
    .where(inArray(sql`lower(${taskTags.tag})`, lowered))
    .all()
}

export function listTaskTags(
  db: DataDb,
  taskIds: readonly string[]
): Array<{ taskId: string; tag: string }> {
  if (taskIds.length === 0) return []
  return db
    .select({ taskId: taskTags.taskId, tag: taskTags.tag })
    .from(taskTags)
    .where(inArray(taskTags.taskId, [...taskIds]))
    .all()
}
