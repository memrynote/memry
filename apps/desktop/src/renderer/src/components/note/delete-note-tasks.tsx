/**
 * "Also delete its tasks", for every dialog that deletes notes.
 *
 * A note holds a task as a `{task:<id>}` line. Deleting the note removes the
 * line, and the task row used to stay in Tasks with nothing saying where it
 * came from. The delete dialogs now ask. The answer defaults to keeping them:
 * deleting a note has never deleted tasks, and a task can outlive its note on
 * purpose.
 *
 * Main decides which tasks count (see `note-carried-tasks.ts`); the dialog only
 * shows the option when there is at least one.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getI18n } from 'react-i18next'
import { useT } from '@memry/i18n/renderer'
import { LabeledCheckbox } from '@/components/ui/labeled-checkbox'
import { notesService } from '@/services/notes-service'
import { tasksService } from '@/services/tasks-service'
import { extractErrorMessage } from '@/lib/ipc-error'

const NONE: string[] = []

export interface NoteTasksChoice {
  /** Tasks the notes carry. Empty until main answers, and when there are none. */
  taskIds: string[]
  deleteTasks: boolean
  setDeleteTasks: (value: boolean) => void
  /** What the confirm handler deletes: the carried tasks when ticked, else nothing. */
  taskIdsToDelete: string[]
}

export function useNoteTasksChoice(
  open: boolean,
  noteIds: string[],
  folderPaths: string[] = NONE
): NoteTasksChoice {
  const { data } = useQuery({
    queryKey: ['notes', 'carried-tasks', noteIds, folderPaths],
    queryFn: async () => (await notesService.getCarriedTasks({ noteIds, folderPaths })).taskIds,
    enabled: open && (noteIds.length > 0 || folderPaths.length > 0),
    // Asked fresh every time the dialog opens: the note may have gained a task
    // since the last delete prompt.
    staleTime: 0,
    gcTime: 0
  })
  const taskIds = data ?? NONE

  const [deleteTasks, setDeleteTasks] = useState(false)
  // Each opening starts unticked, whatever the last one was left at.
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) setDeleteTasks(false)
  }

  return {
    taskIds,
    deleteTasks,
    setDeleteTasks,
    taskIdsToDelete: deleteTasks ? taskIds : NONE
  }
}

export function DeleteNoteTasksOption({
  choice,
  disabled
}: {
  choice: NoteTasksChoice
  disabled?: boolean
}): React.JSX.Element | null {
  const { t } = useT('notes')
  const count = choice.taskIds.length
  if (count === 0) return null

  return (
    <LabeledCheckbox
      checked={choice.deleteTasks}
      onCheckedChange={choice.setDeleteTasks}
      disabled={disabled}
      label={t('deleteNoteTasks.label', { count })}
      description={t('deleteNoteTasks.description', { count })}
      className="mt-1"
    />
  )
}

/**
 * Delete the tasks the user asked to go with their notes. Called only after
 * every note delete succeeded; a failure here leaves the tasks in Tasks, which
 * is where they would have been anyway.
 */
export async function deleteNoteTasks(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return
  const t = getI18n().getFixedT(null, 'notes')
  try {
    const result = await tasksService.bulkDelete(taskIds)
    if (!result.success) toast.error(result.error ?? t('deleteNoteTasks.failed'))
  } catch (err) {
    toast.error(extractErrorMessage(err, t('deleteNoteTasks.failed')))
  }
}
