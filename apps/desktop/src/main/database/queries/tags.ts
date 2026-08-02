import { eq, and, inArray } from 'drizzle-orm'
import { noteTags } from '@memry/db-schema/schema/notes-cache'
import { taskTags } from '@memry/db-schema/schema/task-relations'
import type { TagWithCount } from '@memry/contracts/tags-api'
import { getAllTags, getAllTagDefinitions, getOrCreateTag, deleteTagDefinition } from './notes'
import { getAllTaskTags } from './tasks'

type IndexDb = Parameters<typeof getAllTags>[0]
type DataDb = Parameters<typeof getAllTaskTags>[0]

export function getAllTagsWithCounts(indexDb: IndexDb, dataDb: DataDb): TagWithCount[] {
  const noteCounts = getAllTags(indexDb)
  const taskCounts = getAllTaskTags(dataDb)
  const definitions = getAllTagDefinitions(dataDb)

  // Identity is case-insensitive (lowercase key); display name keeps the
  // first-seen casing from actual usage
  const colorMap = new Map(definitions.map((d) => [d.name.toLowerCase(), d.color]))
  const iconMap = new Map(definitions.map((d) => [d.name.toLowerCase(), d.icon]))
  const categoryIdMap = new Map(definitions.map((d) => [d.name.toLowerCase(), d.categoryId]))
  const sortOrderMap = new Map(definitions.map((d) => [d.name.toLowerCase(), d.sortOrder]))
  const merged = new Map<string, TagWithCount>()

  for (const { tag, count } of noteCounts) {
    const key = tag.toLowerCase().trim()
    const existing = merged.get(key)
    if (existing) {
      existing.count += count
    } else {
      merged.set(key, {
        name: tag.trim(),
        count,
        color: colorMap.get(key),
        icon: iconMap.get(key),
        categoryId: categoryIdMap.get(key) ?? null,
        sortOrder: sortOrderMap.get(key) ?? 0
      })
    }
  }

  for (const { tag, count } of taskCounts) {
    const key = tag.toLowerCase().trim()
    const existing = merged.get(key)
    if (existing) {
      existing.count += count
    } else {
      merged.set(key, {
        name: tag.trim(),
        count,
        color: colorMap.get(key),
        icon: iconMap.get(key),
        categoryId: categoryIdMap.get(key) ?? null,
        sortOrder: sortOrderMap.get(key) ?? 0
      })
    }
  }

  for (const entry of merged.values()) {
    if (!entry.color) {
      const created = getOrCreateTag(dataDb, entry.name)
      entry.color = created.color
      entry.categoryId = created.categoryId
      entry.sortOrder = created.sortOrder
    }
  }

  for (const def of definitions) {
    if (!merged.has(def.name.toLowerCase())) {
      deleteTagDefinition(dataDb, def.name)
    }
  }

  return [...merged.values()].filter((tag) => tag.count > 0).sort((a, b) => b.count - a.count)
}

export function mergeTagInNotes(
  indexDb: IndexDb,
  source: string,
  target: string
): { affected: number; noteIds: string[] } {
  const normalizedSource = source.toLowerCase().trim()
  const trimmedTarget = target.trim()
  const normalizedTarget = trimmedTarget.toLowerCase()

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
      .set({ tag: trimmedTarget })
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
  const trimmedTarget = target.trim()
  const normalizedTarget = trimmedTarget.toLowerCase()

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
      .set({ tag: trimmedTarget })
      .where(and(eq(taskTags.tag, normalizedSource), inArray(taskTags.taskId, remainingTaskIds)))
      .run()
  }

  return { affected: sourceTaskIds.length, taskIds: sourceTaskIds }
}
