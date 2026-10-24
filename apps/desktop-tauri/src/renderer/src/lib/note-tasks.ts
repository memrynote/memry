import type { Task } from '@/data/task-model'

/** The tasks one note carries, as the folder table shows them. */
export interface NoteTasks {
  /** Open tasks first by due date (undated last), then done tasks. */
  tasks: Task[]
  total: number
  open: number
  /** Earliest due date among the open tasks. */
  nextDue: Date | null
}

const byDueDate = (a: Task, b: Task): number => {
  if (a.dueDate && b.dueDate) return a.dueDate.getTime() - b.dueDate.getTime()
  if (a.dueDate) return -1
  if (b.dueDate) return 1
  return a.createdAt.getTime() - b.createdAt.getTime()
}

const summarize = (tasks: Task[]): NoteTasks => {
  const open = tasks.filter((task) => !task.completedAt).toSorted(byDueDate)
  const done = tasks.filter((task) => task.completedAt).toSorted(byDueDate)
  return {
    tasks: [...open, ...done],
    total: tasks.length,
    open: open.length,
    nextDue: open.find((task) => task.dueDate)?.dueDate ?? null
  }
}

/**
 * Groups tasks under every note they belong to: the note the task was written
 * in and each note it is linked to as related. One task can sit under several
 * notes. Archived tasks are left out, and notes without a task get no entry.
 */
export const groupTasksByNote = (
  tasks: readonly Task[],
  noteIds: ReadonlySet<string>
): ReadonlyMap<string, NoteTasks> => {
  const grouped = new Map<string, Task[]>()
  for (const task of tasks) {
    if (task.archivedAt) continue
    const taskNoteIds = new Set([task.sourceNoteId, ...task.linkedNoteIds])
    for (const noteId of taskNoteIds) {
      if (!noteId || !noteIds.has(noteId)) continue
      const list = grouped.get(noteId)
      if (list) list.push(task)
      else grouped.set(noteId, [task])
    }
  }
  return new Map([...grouped].map(([noteId, list]) => [noteId, summarize(list)]))
}
