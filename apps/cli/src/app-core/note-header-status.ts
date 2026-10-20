import { eq } from 'drizzle-orm'
import type { NoteRecord } from '@memry/app-core/service-types'
import { parseStatusCategories } from '@memry/contracts/property-types'
import { statuses, tasks } from '@memry/db-schema/data-schema'
import { getPropertyDefinition } from '@memry/storage-data'
import {
  HEADER_STATUS_PROPERTY,
  deriveHeaderStatus,
  taskStatusCategory,
  type TaskStatusCategory
} from '@memry/shared/note-status'
import { scanTaskCheckboxStates } from '@memry/shared/task-block'
import type { DataDb } from './database.ts'

/**
 * The note with its header status taken from the tasks in its body (#3176),
 * the rule desktop's `main/notes/header-status.ts` applies. Only what the CLI
 * prints changes: the file keeps its stored `status`, and the update paths work
 * from the raw note so the derived value is never written back.
 */
export function withDerivedHeaderStatus(dataDb: DataDb, note: NoteRecord): NoteRecord {
  const taskIds = [...scanTaskCheckboxStates(note.content).keys()]
  if (taskIds.length === 0 || !(HEADER_STATUS_PROPERTY in note.properties)) return note

  const definition = getPropertyDefinition(dataDb, HEADER_STATUS_PROPERTY)
  if (definition?.type !== 'status') return note

  const categories: TaskStatusCategory[] = []
  for (const taskId of taskIds) {
    const task = dataDb.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (!task) continue
    const status = task.statusId
      ? dataDb.select().from(statuses).where(eq(statuses.id, task.statusId)).get()
      : undefined
    categories.push(taskStatusCategory({ completed: task.completedAt != null }, status ?? null))
  }

  const derived = deriveHeaderStatus(categories, parseStatusCategories(definition.options))
  if (derived === null) return note
  return { ...note, properties: { ...note.properties, [HEADER_STATUS_PROPERTY]: derived } }
}
