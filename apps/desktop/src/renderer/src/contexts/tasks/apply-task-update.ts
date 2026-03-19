import type { Task } from '@/data/sample-tasks'

export function applyTaskUpdate(prevTasks: Task[], updatedTask: Task, eventId: string): Task[] {
  const oldTask = prevTasks.find((t) => t.id === eventId)

  const taskWithPreservedDerivedState = oldTask
    ? { ...updatedTask, subtaskIds: oldTask.subtaskIds }
    : updatedTask

  let updated = prevTasks.map((t) => (t.id === eventId ? taskWithPreservedDerivedState : t))

  if (oldTask && oldTask.parentId !== updatedTask.parentId) {
    if (oldTask.parentId) {
      updated = updated.map((t) =>
        t.id === oldTask.parentId
          ? { ...t, subtaskIds: t.subtaskIds.filter((id) => id !== eventId) }
          : t
      )
    }
    if (updatedTask.parentId) {
      updated = updated.map((t) =>
        t.id === updatedTask.parentId ? { ...t, subtaskIds: [...t.subtaskIds, eventId] } : t
      )
    }
  }

  return updated
}
