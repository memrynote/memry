/**
 * A note's header status, derived from the tasks written in its body (#3176).
 *
 * The stored `status` property is never rewritten: builds from before this rule
 * read it, and sync carries it. Only a reader that has the body swaps it for
 * the derived value, and only while the note has tasks. A task id with no row
 * yet, such as one a sync pull has not delivered, is skipped rather than read as
 * to-do.
 */
import { parseStatusCategories } from '@memry/contracts/property-types'
import {
  deriveHeaderStatus,
  isHeaderStatusProperty,
  taskStatusCategory,
  type TaskStatusCategory
} from '@memry/shared/note-status'
import { scanTaskCheckboxStates } from '@memry/shared/task-block'
import { getDatabase, getIndexDatabase } from '../database'
import { getStatusById } from '../database/queries/projects'
import {
  getNoteProperties,
  getPropertyDefinition
} from '../database/queries/notes/property-queries'
import { getTaskById } from '../database/queries/tasks'

export function deriveNoteHeaderStatus(
  noteId: string,
  content: string
): { name: string; value: string } | null {
  const taskIds = [...scanTaskCheckboxStates(content).keys()]
  if (taskIds.length === 0) return null

  const indexDb = getIndexDatabase()
  const stored = getNoteProperties(indexDb, noteId).find((property) =>
    isHeaderStatusProperty(property.name)
  )
  if (stored?.type !== 'status') return null

  const dataDb = getDatabase()
  const categories: TaskStatusCategory[] = []
  for (const taskId of taskIds) {
    const task = getTaskById(dataDb, taskId)
    if (!task) continue
    const status = task.statusId ? getStatusById(dataDb, task.statusId) : undefined
    categories.push(taskStatusCategory({ completed: task.completedAt != null }, status ?? null))
  }

  const definition = getPropertyDefinition(indexDb, stored.name)
  const value = deriveHeaderStatus(categories, parseStatusCategories(definition?.options))
  return value === null ? null : { name: stored.name, value }
}

/** `properties` with the header status replaced by the derived one, when the note has tasks. */
export function withDerivedHeaderStatus(
  noteId: string,
  content: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  const derived = deriveNoteHeaderStatus(noteId, content)
  return derived === null ? properties : { ...properties, [derived.name]: derived.value }
}
