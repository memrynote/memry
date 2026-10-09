import { useEffect, useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'

import { ChevronLeft, Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useExpandedTasks } from '@/hooks'
import { calculateProgress, getSubtasks } from '@/lib/subtask-utils'
import { SortableSubtaskList } from '@/components/tasks/sortable-subtask-list'
import { SubtaskProgressIndicator } from '@/components/tasks/subtask-progress-indicator'
import { InteractiveStatusIcon } from '@/components/tasks/status-icon'
import type { Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { useSubtaskTree } from './subtask-tree-context'
import { TaskExpansionContext } from './task-expansion-context'

interface ZoomedBranchViewProps {
  task: Task
  tasks: Task[]
  project: Project
  onZoom: (taskId: string | null) => void
  onToggleComplete: (taskId: string) => void
  onToggleSubtaskComplete: (taskId: string) => void
  onReorderSubtasks: (parentId: string, newOrder: string[]) => void
  onTaskClick: (taskId: string) => void
}

/**
 * The list scoped to one task's branch: the task is the page title and its
 * subtasks start at the left edge again, so level six reads like level one.
 * The path above the title walks back; ⌘↑ goes one level up.
 */
export const ZoomedBranchView = ({
  task,
  tasks,
  project,
  onZoom,
  onToggleComplete,
  onToggleSubtaskComplete,
  onReorderSubtasks,
  onTaskClick
}: ZoomedBranchViewProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const tree = useSubtaskTree()
  const { expandedIds, toggleExpanded, expand } = useExpandedTasks({
    storageKey: `zoom-${task.id}`,
    persist: true
  })
  const expansion = useMemo(
    () => ({ expandedIds, toggle: toggleExpanded, expand }),
    [expandedIds, toggleExpanded, expand]
  )

  const ancestors = useMemo(() => {
    const out: Task[] = []
    let current = task.parentId ? tasks.find((x) => x.id === task.parentId) : undefined
    const seen = new Set([task.id])
    while (current && !seen.has(current.id)) {
      out.unshift(current)
      seen.add(current.id)
      current = current.parentId ? tasks.find((x) => x.id === current?.parentId) : undefined
    }
    return out
  }, [task, tasks])

  const children = getSubtasks(task.id, tasks)
  const progress = calculateProgress(children)
  const isCompleted = task.completedAt !== null
  const status = project.statuses.find((s) => s.id === task.statusId)

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp') {
        e.preventDefault()
        onZoom(task.parentId)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [task.parentId, onZoom])

  return (
    <TaskExpansionContext.Provider value={expansion}>
      <div
        className="flex flex-1 flex-col overflow-auto px-6 pt-4 pb-10"
        data-testid="zoomed-branch"
      >
        <nav
          aria-label={t('subtaskTree.zoom.path')}
          className="flex min-w-0 flex-wrap items-center gap-1 pb-2 text-xs text-text-secondary"
        >
          <button
            type="button"
            onClick={() => onZoom(task.parentId)}
            className="flex items-center rounded-sm p-0.5 text-text-tertiary hover:bg-muted hover:text-foreground"
            aria-label={t('subtaskTree.zoom.up')}
            title={t('subtaskTree.zoom.upShortcut')}
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onZoom(null)}
            className="rounded-sm px-1 hover:bg-muted hover:text-foreground"
          >
            {project.name}
          </button>
          {ancestors.map((ancestor) => (
            <span key={ancestor.id} className="flex min-w-0 items-center gap-1">
              <span className="text-text-tertiary" aria-hidden="true">
                ›
              </span>
              <button
                type="button"
                onClick={() => onZoom(ancestor.id)}
                className="max-w-[16rem] truncate rounded-sm px-1 hover:bg-muted hover:text-foreground"
              >
                {ancestor.title}
              </button>
            </span>
          ))}
        </nav>

        <div className="flex items-center gap-2.5 pb-4">
          <InteractiveStatusIcon
            type={
              isCompleted ? 'done' : ((status?.type ?? 'todo') as 'todo' | 'in_progress' | 'done')
            }
            color={status?.color ?? 'var(--text-tertiary)'}
            isCompleted={isCompleted}
            onClick={() => onToggleComplete(task.id)}
          />
          <button
            type="button"
            onClick={() => onTaskClick(task.id)}
            className={cn(
              'min-w-0 truncate text-start text-xl font-semibold tracking-tight text-foreground',
              isCompleted && 'text-text-tertiary line-through'
            )}
          >
            {task.title}
          </button>
          <SubtaskProgressIndicator completed={progress.completed} total={progress.total} />
        </div>

        <SortableSubtaskList
          parent={task}
          subtasks={children}
          allTasks={tasks}
          statuses={project.statuses}
          onReorder={onReorderSubtasks}
          onToggleComplete={onToggleSubtaskComplete}
          onClick={onTaskClick}
        />

        {tree && tree.draftParentId !== task.id && (
          <button
            type="button"
            onClick={() => tree.openDraft(task.id)}
            className="mt-1 flex items-center gap-2 rounded-sm py-1.5 ps-6 text-[13px] text-text-tertiary hover:bg-muted hover:text-foreground"
          >
            <Plus className="size-3.5" />
            {t('subtaskTree.addSubtask')}
          </button>
        )}
      </div>
    </TaskExpansionContext.Provider>
  )
}
