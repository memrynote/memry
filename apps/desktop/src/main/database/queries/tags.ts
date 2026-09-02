import { eq, and, inArray } from 'drizzle-orm'
import { noteTags } from '@memry/db-schema/schema/notes-cache'
import { taskTags } from '@memry/db-schema/schema/task-relations'
import type { TagWithCount } from '@memry/contracts/tags-api'
import { getAllTags, getAllTagDefinitions, getOrCreateTag, deleteTagDefinition } from './notes'
import { getAllTaskTags } from './tasks'

type IndexDb = Parameters<typeof getAllTags>[0]
type DataDb = Parameters<typeof getAllTaskTags>[0]

/**
 * Whether a definition row records a decision someone made about the tag, as
 * opposed to one `getOrCreateTag` minted on the way past.
 *
 * Only three surfaces set `colorAuthored` — the two colour pickers and the tag
 * hub's create affordance (`tags:update-color`) — so it, an icon, and a
 * category assignment are between them every deliberate mark a user can leave
 * on a tag. A tag created in the hub carries an authored colour from the
 * moment it exists, which is what keeps it alive before any note uses it.
 */
function isAuthored(definition: {
  colorAuthored: boolean
  icon: string | null
  categoryId: string | null
}): boolean {
  return definition.colorAuthored || definition.icon !== null || definition.categoryId !== null
}

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

  // A definition with no usage behind it is either a tag someone made and has
  // not filed anywhere yet — the tag hub's "New tag" — or the leftovers of one
  // whose last note dropped it, in which case collecting it is what stops
  // renaming `#foo` to `#bar` inside a note leaving `foo` behind forever. The
  // authored ones are listed at zero; the rest are still collected.
  const registered: TagWithCount[] = []
  for (const def of definitions) {
    if (merged.has(def.name.toLowerCase())) continue
    if (!isAuthored(def)) {
      deleteTagDefinition(dataDb, def.name)
      continue
    }
    registered.push({
      name: def.name,
      count: 0,
      color: def.color,
      icon: def.icon,
      categoryId: def.categoryId,
      sortOrder: def.sortOrder
    })
  }

  return [
    ...[...merged.values()].filter((tag) => tag.count > 0).sort((a, b) => b.count - a.count),
    ...registered.sort((a, b) => a.name.localeCompare(b.name))
  ]
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
