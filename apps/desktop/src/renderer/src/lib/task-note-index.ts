import type { NoteListItem } from '@memry/rpc/notes'

import { extractFolderFromPath, getDisplayName } from '@/components/notes-tree-utils'
import type { Task } from '@/data/task-model'

/**
 * What grouping by folder or note needs to know about one note.
 *
 * A task only stores note ids, so the folder a task belongs to is a property of
 * the note it came from. This index is the renderer-side join between the two.
 */
export interface TaskNoteInfo {
  id: string
  /** Note title, already falling back to the file name. */
  title: string
  /** Vault-relative folder of the note. `''` is the vault root. */
  folderPath: string
}

export type TaskNoteIndex = Map<string, TaskNoteInfo>

export const buildTaskNoteIndex = (
  notes: Pick<NoteListItem, 'id' | 'path' | 'title'>[]
): TaskNoteIndex =>
  new Map(
    notes.map((note) => [
      note.id,
      {
        id: note.id,
        title: note.title?.trim() || getDisplayName(note.path),
        folderPath: extractFolderFromPath(note.path)
      }
    ])
  )

/**
 * The note a task is filed under.
 *
 * `sourceNoteId` wins because it is where the task line physically lives. A
 * task typed in the Tasks page has no source note but can still be attached to
 * one, so the first related note is the next best answer. Everything else is
 * unfiled.
 */
export const getTaskNoteId = (task: Task): string | null =>
  task.sourceNoteId ?? task.linkedNoteIds[0] ?? null
