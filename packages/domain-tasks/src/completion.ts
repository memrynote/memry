import type { TasksCommandRepository } from './commands-types.ts'
import type { Status, Task } from './types.ts'

/**
 * A task is done in two stored places: `completedAt`, which the calendar, the
 * timeline and the overdue counts read, and its status's `isDone`, which the
 * Tasks views read. The commands in this package keep the two in agreement, so
 * a task completed from any surface is done on every surface. These helpers say
 * what the second place must become when the first one changes, and back.
 */

type StatusLookup = Pick<TasksCommandRepository, 'getStatus' | 'listStatuses'>

const byPosition = (a: Status, b: Status): number => a.position - b.position

function currentStatus(repository: StatusLookup, task: Task | undefined): Status | undefined {
  return task?.statusId ? repository.getStatus(task.statusId) : undefined
}

/**
 * The done status a completed task moves to, or undefined when it already sits
 * in one (or its project has none). A task whose status is gone moves too.
 */
export function doneStatusIdOnComplete(
  repository: StatusLookup,
  task: Task | undefined
): string | undefined {
  if (!task || currentStatus(repository, task)?.isDone) return undefined
  return repository
    .listStatuses(task.projectId)
    .filter((status) => status.isDone)
    .toSorted(byPosition)[0]?.id
}

/**
 * The open status a reopened task moves to, or undefined when it is not in a
 * done status. The project's default status wins, else its first open one.
 */
export function openStatusIdOnReopen(
  repository: StatusLookup,
  task: Task | undefined
): string | undefined {
  if (!task || !currentStatus(repository, task)?.isDone) return undefined
  const open = repository
    .listStatuses(task.projectId)
    .filter((status) => !status.isDone)
    .toSorted(byPosition)
  return (open.find((status) => status.isDefault) ?? open[0])?.id
}

/**
 * The `completedAt` a task takes when it lands in `status`: now when a done
 * status completes an open task, null when an open status reopens a completed
 * one, undefined when nothing changes. An existing completion time survives a
 * move between done statuses.
 */
export function completedAtOnStatus(
  task: Task | undefined,
  status: Status | undefined,
  now: string
): string | null | undefined {
  if (!task || !status) return undefined
  if (status.isDone) return task.completedAt ? undefined : now
  return task.completedAt ? null : undefined
}
