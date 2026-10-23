import { eq } from 'drizzle-orm'
import type { NotesService } from '@memry/app-core/service-types'
import type { DeleteTaskOptions, TaskRecord, TasksService } from '@memry/app-core/tasks'
import { parseStatusCategories } from '@memry/contracts/property-types'
import { statuses, tasks } from '@memry/db-schema/data-schema'
import { getPropertyDefinition } from '@memry/storage-data'
import {
  deriveHeaderStatus,
  findHeaderStatusProperty,
  taskStatusCategory,
  type TaskStatusCategory
} from '@memry/shared/note-status'
import { scanTaskCheckboxStates } from '@memry/shared/task-block'
import type { DataDb } from './database.ts'

/**
 * A note's header status follows the tasks in its body (#3176), the rule
 * desktop's `main/notes/header-status.ts` applies: a task change writes the
 * status those tasks imply into the note's `status` property, a user's own pick
 * stays until the next task change, and every reader just reads the property.
 */
async function syncHeaderStatus(
  dataDb: DataDb,
  notes: NotesService,
  noteId: string,
  alsoTaskId: string
): Promise<void> {
  const note = await notes.get(noteId)
  if (!note) return
  const name = findHeaderStatusProperty(note.properties)
  if (name === undefined) return
  const definition = getPropertyDefinition(dataDb, name)
  if (definition?.type !== 'status') return

  const taskIds = new Set(scanTaskCheckboxStates(note.content).keys())
  taskIds.add(alsoTaskId)
  const categories: TaskStatusCategory[] = []
  for (const taskId of taskIds) {
    const task = dataDb.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (!task) continue
    const status = task.statusId
      ? dataDb.select().from(statuses).where(eq(statuses.id, task.statusId)).get()
      : undefined
    categories.push(taskStatusCategory({ completed: task.completedAt != null }, status ?? null))
  }

  const value = deriveHeaderStatus(categories, parseStatusCategories(definition.options))
  if (value === null || value === note.properties[name]) return
  await notes.update({ id: noteId, properties: { ...note.properties, [name]: value } })
}

function noteIdsOf(task: TaskRecord): string[] {
  return [...new Set([task.sourceNoteId, ...task.linkedNoteIds])].filter(
    (id): id is string => typeof id === 'string' && id !== ''
  )
}

/**
 * `tasksService` whose writes refresh the header status of the notes holding
 * the task they changed. A delete reads the task first, because its notes are
 * only known from the row.
 */
export function withHeaderStatusSync(
  tasksService: TasksService,
  dataDb: DataDb,
  notes: NotesService
): TasksService {
  const refresh = async (tasksChanged: TaskRecord[]): Promise<void> => {
    for (const task of tasksChanged) {
      for (const noteId of noteIdsOf(task)) await syncHeaderStatus(dataDb, notes, noteId, task.id)
    }
  }
  const after =
    <A extends unknown[]>(write: (...args: A) => Promise<TaskRecord>) =>
    async (...args: A): Promise<TaskRecord> => {
      const result = await write(...args)
      await refresh([result])
      return result
    }
  const afterIds =
    <A extends [string[], ...unknown[]]>(write: (...args: A) => Promise<number>) =>
    async (...args: A): Promise<number> => {
      const before = (await Promise.all(args[0].map((id) => tasksService.get(id)))).filter(
        (task): task is TaskRecord => task !== null
      )
      const result = await write(...args)
      await refresh(before)
      return result
    }

  return {
    ...tasksService,
    create: after((input) => tasksService.create(input)),
    update: async (id, updates) => {
      const result = await tasksService.update(id, updates)
      if (updates.statusId !== undefined || updates.projectId !== undefined) {
        await refresh([result])
      }
      return result
    },
    complete: after((id) => tasksService.complete(id)),
    reopen: after((id) => tasksService.reopen(id)),
    move: async (id, input) => {
      const result = await tasksService.move(id, input)
      if (input.statusId !== undefined || input.projectId !== undefined) await refresh([result])
      return result
    },
    duplicate: after((id) => tasksService.duplicate(id)),
    bulkComplete: afterIds((ids) => tasksService.bulkComplete(ids)),
    bulkMove: afterIds((ids, projectId) => tasksService.bulkMove(ids, projectId)),
    bulkDelete: afterIds((ids: string[], options?: DeleteTaskOptions) =>
      tasksService.bulkDelete(ids, options)
    )
  }
}
