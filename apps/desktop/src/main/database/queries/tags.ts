import { eq, and, inArray } from 'drizzle-orm'
import { noteTags } from '@memry/db-schema/schema/notes-cache'
import { taskTags } from '@memry/db-schema/schema/task-relations'
import type { TagWithCount } from '@memry/contracts/tags-api'
import { getAllTags, getAllTagDefinitions, getOrCreateTag } from './notes'
import { getAllTaskTags } from './tasks'

type IndexDb = Parameters<typeof getAllTags>[0]
type DataDb = Parameters<typeof getAllTaskTags>[0]

export function getAllTagsWithCounts(indexDb: IndexDb, dataDb: DataDb): TagWithCount[] {
  const noteCounts = getAllTags(indexDb)
  const taskCounts = getAllTaskTags(dataDb)
  const definitions = getAllTagDefinitions(dataDb)

  const colorMap = new Map(definitions.map((d) => [d.name, d.color]))
  const merged = new Map<string, TagWithCount>()

  for (const { tag, count } of noteCounts) {
    const name = tag.toLowerCase().trim()
    merged.set(name, { name, count, color: colorMap.get(name) })
  }

  for (const { tag, count } of taskCounts) {
    const name = tag.toLowerCase().trim()
    const existing = merged.get(name)
    if (existing) {
      existing.count += count
    } else {
      merged.set(name, { name, count, color: colorMap.get(name) })
    }
  }

  for (const entry of merged.values()) {
    if (!entry.color) {
      const created = getOrCreateTag(dataDb, entry.name)
      entry.color = created.color
    }
  }

  return [...merged.values()].sort((a, b) => b.count - a.count)
}

export function mergeTagInNotes(
  indexDb: IndexDb,
  source: string,
  target: string
): { affected: number; noteIds: string[] } {
  const normalizedSource = source.toLowerCase().trim()
  const normalizedTarget = target.toLowerCase().trim()

  if (normalizedSource === normalizedTarget) {
    return { affected: 0, noteIds: [] }
  }

  const sourceRows = indexDb
    .select({ noteId: noteTags.noteId })
    .from(noteTags)
    .where(eq(noteTags.tag, normalizedSource))
    .all()

  if (sourceRows.length === 0) {
    return { affected: 0, noteIds: [] }
  }

  const sourceNoteIds = sourceRows.map((r) => r.noteId)

  const notesWithTarget = new Set(
    indexDb
      .select({ noteId: noteTags.noteId })
      .from(noteTags)
      .where(and(eq(noteTags.tag, normalizedTarget), inArray(noteTags.noteId, sourceNoteIds)))
      .all()
      .map((r) => r.noteId)
  )

  const duplicateNoteIds = sourceNoteIds.filter((id) => notesWithTarget.has(id))
  if (duplicateNoteIds.length > 0) {
    indexDb
      .delete(noteTags)
      .where(and(eq(noteTags.tag, normalizedSource), inArray(noteTags.noteId, duplicateNoteIds)))
      .run()
  }

  const remainingNoteIds = sourceNoteIds.filter((id) => !notesWithTarget.has(id))
  if (remainingNoteIds.length > 0) {
    indexDb
      .update(noteTags)
      .set({ tag: normalizedTarget })
      .where(and(eq(noteTags.tag, normalizedSource), inArray(noteTags.noteId, remainingNoteIds)))
      .run()
  }

  return { affected: sourceNoteIds.length, noteIds: sourceNoteIds }
}

export function mergeTagInTasks(
  dataDb: DataDb,
  source: string,
  target: string
): { affected: number; taskIds: string[] } {
  const normalizedSource = source.toLowerCase().trim()
  const normalizedTarget = target.toLowerCase().trim()

  if (normalizedSource === normalizedTarget) {
    return { affected: 0, taskIds: [] }
  }

  const sourceRows = dataDb
    .select({ taskId: taskTags.taskId })
    .from(taskTags)
    .where(eq(taskTags.tag, normalizedSource))
    .all()

  if (sourceRows.length === 0) {
    return { affected: 0, taskIds: [] }
  }

  const sourceTaskIds = sourceRows.map((r) => r.taskId)

  const tasksWithTarget = new Set(
    dataDb
      .select({ taskId: taskTags.taskId })
      .from(taskTags)
      .where(and(eq(taskTags.tag, normalizedTarget), inArray(taskTags.taskId, sourceTaskIds)))
      .all()
      .map((r) => r.taskId)
  )

  const duplicateTaskIds = sourceTaskIds.filter((id) => tasksWithTarget.has(id))
  if (duplicateTaskIds.length > 0) {
    dataDb
      .delete(taskTags)
      .where(and(eq(taskTags.tag, normalizedSource), inArray(taskTags.taskId, duplicateTaskIds)))
      .run()
  }

  const remainingTaskIds = sourceTaskIds.filter((id) => !tasksWithTarget.has(id))
  if (remainingTaskIds.length > 0) {
    dataDb
      .update(taskTags)
      .set({ tag: normalizedTarget })
      .where(and(eq(taskTags.tag, normalizedSource), inArray(taskTags.taskId, remainingTaskIds)))
      .run()
  }

  return { affected: sourceTaskIds.length, taskIds: sourceTaskIds }
}
