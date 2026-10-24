import { useMemo } from 'react'

import { useTasksOptional } from '@/contexts/tasks'
import { groupTasksByNote, type NoteTasks } from '@/lib/note-tasks'

/**
 * The tasks each of `noteIds` carries, for the folder table's expandable rows.
 * `undefined` outside a tasks provider, which reads as "show no task UI".
 */
export const useNoteTasks = (
  noteIds: readonly string[]
): ReadonlyMap<string, NoteTasks> | undefined => {
  const tasks = useTasksOptional()?.tasks
  return useMemo(
    () => (tasks ? groupTasksByNote(tasks, new Set(noteIds)) : undefined),
    [tasks, noteIds]
  )
}
