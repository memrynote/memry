/**
 * A note's header status follows the tasks written in its body (#3176).
 *
 * The status is stored, as any property is: a task change writes the status
 * those tasks imply into the note's `status` property, and a user's own pick is
 * an ordinary edit that stays until the next task change writes over it. Last
 * writer wins. Every reader (folder view, filters, sort, the CLI, agents, sync)
 * then reads one stored value and none of them derives it.
 *
 * Only a property named `status` in any case and declared as type `status`
 * follows tasks. A task id with no row yet (a sync not delivered) is skipped,
 * not read as to-do.
 */
import { parseStatusCategories } from '@memry/contracts/property-types'
import {
  deriveHeaderStatus,
  isHeaderStatusProperty,
  taskStatusCategory,
  type TaskStatusCategory
} from '@memry/shared/note-status'
import { scanTaskCheckboxStates } from '@memry/shared/task-block'
import { createLogger } from '../lib/logger'
import { getDatabase, getIndexDatabase } from '../database'
import { getStatusById } from '../database/queries/projects'
import {
  getNoteProperties,
  getPropertyDefinition
} from '../database/queries/notes/property-queries'
import { getTaskById } from '../database/queries/tasks'
import { getNoteById } from '../vault/notes-crud'
import { mergeEntityProperties } from './entity-properties'

const logger = createLogger('HeaderStatus')

/** The `Task` fields that decide which notes a task change can reach. */
interface TaskLinks {
  id: string
  sourceNoteId?: string | null
  linkedNoteIds?: string[] | null
}

/** Task fields whose change can move a note's status. */
const STATUS_FIELDS = new Set(['statusId', 'completedAt', 'projectId'])

export function changesTaskStatus(changedFields: readonly string[]): boolean {
  return changedFields.some((field) => STATUS_FIELDS.has(field))
}

/**
 * Writes the status the tasks in `noteId` imply into its status property.
 * `onlyIfEmpty` fills a property that has no value yet, for one the user just
 * added, and leaves a chosen value alone.
 */
export async function syncHeaderStatus(
  noteId: string,
  options: { onlyIfEmpty?: boolean; alsoTaskId?: string } = {}
): Promise<void> {
  const indexDb = getIndexDatabase()
  const stored = getNoteProperties(indexDb, noteId).find((property) =>
    isHeaderStatusProperty(property.name)
  )
  if (stored?.type !== 'status') return
  const hasValue = stored.value !== null && stored.value !== undefined && stored.value !== ''
  if (options.onlyIfEmpty && hasValue) return

  const note = await getNoteById(noteId)
  if (!note) return
  const taskIds = new Set(scanTaskCheckboxStates(note.content).keys())
  // A task created in the editor lands in the file only after the write-back.
  if (options.alsoTaskId) taskIds.add(options.alsoTaskId)

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
  if (value === null || value === stored.value) return

  const result = await mergeEntityProperties(noteId, { [stored.name]: value })
  if (!result.success) logger.warn('Could not write the header status', { noteId })
}

/** One write at a time per note, so two task changes do not race on one file. */
const queues = new Map<string, Promise<void>>()

function enqueue(noteId: string, work: () => Promise<void>): void {
  const run = (queues.get(noteId) ?? Promise.resolve())
    .then(work)
    .catch((error: unknown) => logger.warn('Header status sync failed', { noteId, error }))
  queues.set(noteId, run)
  void run.finally(() => {
    if (queues.get(noteId) === run) queues.delete(noteId)
  })
}

/**
 * After a task write: the notes that hold the task recompute their status.
 * Never throws and never waits, so a status write cannot fail or slow the task
 * write that caused it.
 */
export function syncHeaderStatusForTask(task: TaskLinks): void {
  const noteIds = new Set([task.sourceNoteId, ...(task.linkedNoteIds ?? [])])
  for (const noteId of noteIds) {
    if (!noteId) continue
    enqueue(noteId, () => syncHeaderStatus(noteId, { alsoTaskId: task.id }))
  }
}

/**
 * After a property write: a status property the user just added (still empty)
 * on a note that already has tasks takes the status they imply, instead of
 * asking the user to pick one. A value the user chose is left alone.
 */
export function fillHeaderStatus(noteId: string): void {
  enqueue(noteId, () => syncHeaderStatus(noteId, { onlyIfEmpty: true }))
}
