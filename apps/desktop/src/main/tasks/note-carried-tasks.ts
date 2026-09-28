/**
 * The tasks a note carries, for the delete dialog's "also delete its tasks".
 *
 * A note holds a task as a `- [ ] Title {task:<id>}` line. Deleting the note
 * removes the line and nothing else: the `tasks` row stays in Tasks. The
 * dialog asks first, and this is what it asks about.
 *
 * Only lines count, not `task_notes` links. A task linked to the note from the
 * Tasks view never lived in it, and deleting the note must not take it. A task
 * whose line is here but which is also linked to a note that survives the
 * delete is left out too: it still has a home.
 *
 * @module tasks/note-carried-tasks
 */

import fs from 'fs/promises'
import { scanTaskCheckboxStates } from '@memry/shared/task-block'
import { classifyMarkdownStat } from '@memry/shared/markdown-class'
import { getTaskById, getTaskNoteIds } from '@main/database/queries/tasks'
import {
  getNoteCacheById,
  listNoteCacheUnderFolder,
  noteCacheExists
} from '@main/database/queries/notes'
import { getDatabase, getIndexDatabase, isDatabaseInitialized } from '../database'
import { safeRead } from '../vault/file-ops'
import { toAbsolutePath } from '../vault/notes-io'

export interface CarrierNote {
  id: string
  /** The note file's text, or null when it could not be read. */
  markdown: string | null
}

export interface CarriedTaskDeps {
  taskExists(taskId: string): boolean
  linkedNoteIds(taskId: string): string[]
  noteExists(noteId: string): boolean
}

/** Task ids carried by `notes`, in first-seen order, minus the ones that stay homed. */
export function selectCarriedTaskIds(notes: CarrierNote[], deps: CarriedTaskDeps): string[] {
  const deleting = new Set(notes.map((note) => note.id))
  const found = new Set<string>()
  for (const note of notes) {
    if (!note.markdown) continue
    for (const taskId of scanTaskCheckboxStates(note.markdown).keys()) found.add(taskId)
  }

  return [...found].filter(
    (taskId) =>
      deps.taskExists(taskId) &&
      !deps.linkedNoteIds(taskId).some((noteId) => !deleting.has(noteId) && deps.noteExists(noteId))
  )
}

// A file over the note byte ceiling opens read-only and never reaches the
// editor, so no task line in it was ever converted. Skipping it keeps a
// multi-hundred-MB log out of a main-process string.
async function readCarrierMarkdown(relativePath: string): Promise<string | null> {
  const absolutePath = toAbsolutePath(relativePath)
  const stats = await fs.stat(absolutePath).catch(() => null)
  if (!stats || classifyMarkdownStat(stats.size)) return null
  return safeRead(absolutePath)
}

export async function getCarriedTaskIds(input: {
  noteIds: string[]
  folderPaths: string[]
}): Promise<string[]> {
  if (!isDatabaseInitialized()) return []
  const indexDb = getIndexDatabase()
  const dataDb = getDatabase()

  const paths = new Map<string, string>()
  for (const noteId of input.noteIds) {
    const cached = getNoteCacheById(indexDb, noteId)
    if (cached) paths.set(cached.id, cached.path)
  }
  for (const folderPath of input.folderPaths) {
    for (const row of listNoteCacheUnderFolder(indexDb, folderPath)) paths.set(row.id, row.path)
  }

  const notes = await Promise.all(
    [...paths].map(async ([id, path]) => ({ id, markdown: await readCarrierMarkdown(path) }))
  )

  return selectCarriedTaskIds(notes, {
    taskExists: (taskId) => getTaskById(dataDb, taskId) !== undefined,
    linkedNoteIds: (taskId) => getTaskNoteIds(dataDb, taskId),
    noteExists: (noteId) => noteCacheExists(indexDb, noteId)
  })
}
