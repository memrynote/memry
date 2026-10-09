/**
 * Read-only counts behind tag-schema dialogs: header carriers, field values
 * and task field maps. Object membership: the tag in the note's header, a
 * markdown file, not a journal entry.
 */
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { noteCache, noteProperties, noteTags } from '@memry/db-schema/schema/notes-cache'
import { taskTags } from '@memry/db-schema/schema/task-relations'
import { tasks } from '@memry/db-schema/schema/tasks'
import { plainVersionedMap, type JsonValue } from '@memry/shared/versioned'
import type { DataDb, IndexDb } from '../types'

/** Notes whose header carries one of `tags` (lowercase), markdown, not journals. */
export function headerObjectNoteIds(db: IndexDb, tags: readonly string[]): string[] {
  if (tags.length === 0) return []
  return db
    .selectDistinct({ noteId: noteTags.noteId })
    .from(noteTags)
    .innerJoin(noteCache, eq(noteCache.id, noteTags.noteId))
    .where(
      and(
        inArray(noteTags.tag, [...tags]),
        eq(noteTags.inHeader, true),
        eq(noteCache.fileType, 'markdown'),
        isNull(noteCache.date)
      )
    )
    .all()
    .map((row) => row.noteId)
}

/** Note ids among `noteIds` that hold a value named `name`, or every holder when `noteIds` is null. */
export function notesWithProperty(
  db: IndexDb,
  name: string,
  noteIds: readonly string[] | null = null
): string[] {
  if (noteIds !== null && noteIds.length === 0) return []
  return db
    .select({ noteId: noteProperties.noteId })
    .from(noteProperties)
    .where(
      noteIds === null
        ? eq(noteProperties.name, name)
        : and(eq(noteProperties.name, name), inArray(noteProperties.noteId, [...noteIds]))
    )
    .all()
    .map((row) => row.noteId)
}

export function countPropertyValues(
  db: IndexDb,
  noteIds: readonly string[],
  names: readonly string[]
): number {
  if (noteIds.length === 0 || names.length === 0) return 0
  return db
    .select({ noteId: noteProperties.noteId })
    .from(noteProperties)
    .where(
      and(inArray(noteProperties.noteId, [...noteIds]), inArray(noteProperties.name, [...names]))
    )
    .all().length
}

export function taskIdsWithTags(db: DataDb, tags: readonly string[]): string[] {
  if (tags.length === 0) return []
  return db
    .selectDistinct({ taskId: taskTags.taskId })
    .from(taskTags)
    .where(inArray(taskTags.tag, [...tags]))
    .all()
    .map((row) => row.taskId)
}

/** Every task with a field map, as plain values (removals dropped). */
export function taskFieldValues(
  db: DataDb
): Array<{ id: string; fields: Record<string, Exclude<JsonValue, null>> }> {
  return db
    .select({ id: tasks.id, fields: tasks.fields })
    .from(tasks)
    .where(isNotNull(tasks.fields))
    .all()
    .map((row) => ({ id: row.id, fields: plainVersionedMap(row.fields) }))
}
