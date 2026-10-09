import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useT } from '@memry/i18n/renderer'
import { buildTaskTree } from '@memry/domain-tasks/tree'

import type { Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'

/**
 * A date view lists each dated task as its own row, at any depth (F2). Rows
 * under a provider draw every task in their list as a row, say where a subtask
 * lives under its title, and look subtasks up in the whole task list, since a
 * parent's undated subtasks are not rows of the view.
 */
export interface DateViewValue {
  /** Every non-archived task, for a row's subtasks and a subtask's path. */
  tasks: Task[]
  /** "Project › … › Parent" for a subtask, null for a top-level task. */
  pathOf: (task: Task) => string[] | null
  /** Opens the subtask's project zoomed into its parent, with the subtask selected. */
  openPath: (task: Task) => void
}

export const DateViewContext = createContext<DateViewValue | null>(null)

export const useDateView = (): DateViewValue | null => useContext(DateViewContext)

/**
 * The project, then the tasks above `taskId` from the top down. More than two
 * keeps the top one's project and the direct parent and folds the rest into
 * `…`, so the path stays one line of context.
 */
export const foldTaskPath = (projectName: string, ancestorTitles: string[]): string[] =>
  ancestorTitles.length > 2
    ? [projectName, '…', ancestorTitles[ancestorTitles.length - 1]]
    : [projectName, ...ancestorTitles]

export const useDateViewValue = (
  allTasks: Task[],
  projects: Project[],
  openPath: (task: Task) => void
): DateViewValue =>
  useMemo(() => {
    const tasks = allTasks.filter((task) => !task.archivedAt)
    const tree = buildTaskTree(tasks)
    const projectNames = new Map(projects.map((project) => [project.id, project.name]))
    const pathOf = (task: Task): string[] | null => {
      const ancestorIds = tree.ancestorIds(task.id)
      if (ancestorIds.length === 0) return null
      const titles = [...ancestorIds].reverse().map((id) => tree.get(id)?.title ?? '')
      return foldTaskPath(projectNames.get(task.projectId) ?? '', titles)
    }
    return { tasks, pathOf, openPath }
  }, [allTasks, projects, openPath])

/**
 * The tasks a date view's rows nest: `tasks` with the listed rows dropped from
 * every `subtaskIds`, so a task that is its own row never shows again inside a
 * parent's branch, at any depth.
 */
export const nestUnlisted = (tasks: Task[], rowIds: ReadonlySet<string>): Task[] =>
  tasks.map((task) =>
    task.subtaskIds.some((id) => rowIds.has(id))
      ? { ...task, subtaskIds: task.subtaskIds.filter((id) => !rowIds.has(id)) }
      : task
  )

/** A subtask's path in the date view it is listed in; null anywhere else. */
export const useTaskPath = (task: Task): string[] | null => useDateView()?.pathOf(task) ?? null

/** The row's title with, for a subtask in a date view, its path under it. */
export const TaskPathTitle = ({
  task,
  path,
  children
}: {
  task: Task
  path: string[] | null
  children: ReactNode
}): ReactNode => {
  const { t } = useT('tasks')
  const dateView = useDateView()
  if (!path || !dateView) return children
  const label = path.join(' › ')
  return (
    <div className="flex min-w-0 grow shrink flex-col">
      {children}
      <button
        type="button"
        data-testid="task-path"
        aria-label={t('subtaskTree.openPath', { path: label })}
        onClick={(event) => {
          event.stopPropagation()
          dateView.openPath(task)
        }}
        onKeyDown={(event) => event.stopPropagation()}
        className="w-fit max-w-full truncate text-start text-[11px] leading-3.5 text-text-tertiary hover:text-text-secondary hover:underline focus-visible:underline focus-visible:outline-none"
      >
        {label}
      </button>
    </div>
  )
}
