import type React from 'react'
import { useCallback, useMemo } from 'react'
import { useTaskWorkspaceData, useTaskWorkspaceMutations } from '@/features/tasks/use-task-queries'
import {
  arrangeWidgetRows,
  selectTasksForWidget,
  widgetNeedsNoteIndex
} from '@/lib/home/tasks-widget-filter'
import { useTaskNoteIndex } from '@/hooks/use-task-note-index'
import { useSavedFilters } from '@/hooks/use-task-filters'
import { useTabActions } from '@/contexts/tabs/context'
import { TaskRow } from '@/components/tasks/task-row'
import { ParentTaskRow } from '@/components/tasks/parent-task-row'
import { useExpandedTasks } from '@/hooks/use-expanded-tasks'
import { calculateProgress, getSubtasks } from '@/lib/subtask-utils'
import { type Project } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'
import { DateViewContext, useDateViewValue } from '@/components/tasks/date-view-context'
import { openTaskInTasksTab, useOpenTaskDetail } from '@/components/tasks/task-detail-host'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import { Skeleton } from '@/components/ui/skeleton'
import { extractErrorMessage } from '@/lib/ipc-error'
import { CheckSquare } from '@/lib/icons/icon-map'
import { WidgetRow, WidgetEmptyState } from './widget-list'
import { useT } from '@memry/i18n/renderer'

export function TasksWidget({ config, size }: WidgetComponentProps): React.JSX.Element {
  const { t } = useT('common')
  const limit = size === 'L' ? 12 : size === 'M' ? 6 : 3
  const { tasks, projects, isLoading, error } = useTaskWorkspaceData({ enabled: true })
  const { updateTask } = useTaskWorkspaceMutations()
  const { openTab } = useTabActions()
  const { savedFilters } = useSavedFilters()

  const noteIndex = useTaskNoteIndex(widgetNeedsNoteIndex(savedFilters ?? [], config))

  const openTaskDetail = useOpenTaskDetail()
  // The user's last expand/collapse sticks across launches (localStorage).
  const { isExpanded, toggleExpanded } = useExpandedTasks({ storageKey: 'home-widget' })

  const { rows, nestable } = useMemo(() => {
    const selected = selectTasksForWidget(tasks, projects, savedFilters ?? [], config, noteIndex)
    const arranged = arrangeWidgetRows(tasks, selected, savedFilters ?? [], config)
    return { rows: arranged.rows.slice(0, limit), nestable: arranged.nestable }
  }, [tasks, projects, savedFilters, config, noteIndex, limit])

  // A subtask's path opens Tasks zoomed into its parent, with it open.
  const openPath = useCallback(
    (task: Task) => openTaskInTasksTab(openTab, task.id, task.projectId, task.parentId),
    [openTab]
  )
  const dateView = useDateViewValue(tasks, projects, openPath)

  if (isLoading)
    return (
      <div className="flex flex-col gap-1" aria-busy="true" aria-label={t('state.loading')}>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    )

  if (error)
    return (
      <div className="text-xs text-destructive" role="alert" title={extractErrorMessage(error)}>
        {t('home.widget.loadError')}
      </div>
    )

  if (rows.length === 0) return <WidgetEmptyState icon={CheckSquare} label={t('home.noTasksYet')} />

  return (
    <DateViewContext.Provider value={dateView}>
      <ul className="flex flex-col gap-0.5">
        {rows.map((task) => {
          const project =
            projects.find((p) => p.id === task.projectId) ??
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- placeholder for a task whose project is not loaded; fabricating the missing icon/description/dates would change what consumers see
            ({
              id: task.projectId,
              name: '',
              color: 'var(--text-tertiary)',
              statuses: []
            } as unknown as Project)

          const toggleComplete = (id: string): void => {
            const target = nestable.find((candidate) => candidate.id === id) ?? task
            void updateTask(id, { completedAt: target.completedAt ? null : new Date() })
          }
          const subtasks = getSubtasks(task.id, nestable)

          if (subtasks.length > 0) {
            return (
              <WidgetRow key={task.id} data-testid="task-item" data-task-id={task.id}>
                <ParentTaskRow
                  task={task}
                  project={project}
                  projects={projects}
                  allTasks={nestable}
                  subtasks={subtasks}
                  progress={calculateProgress(subtasks)}
                  isExpanded={isExpanded(task.id)}
                  isCompleted={task.completedAt != null}
                  showProjectBadge
                  onToggleExpand={toggleExpanded}
                  onToggleComplete={toggleComplete}
                  onToggleSubtaskComplete={toggleComplete}
                  onUpdateTask={(id, updates) => {
                    void updateTask(id, updates)
                  }}
                  onClick={openTaskDetail}
                />
              </WidgetRow>
            )
          }

          return (
            <WidgetRow key={task.id} data-testid="task-item" data-task-id={task.id}>
              <TaskRow
                task={task}
                project={project}
                projects={projects}
                isCompleted={task.completedAt != null}
                showProjectBadge
                onToggleComplete={toggleComplete}
                onUpdateTask={(id, updates) => {
                  void updateTask(id, updates)
                }}
                onClick={openTaskDetail}
              />
            </WidgetRow>
          )
        })}
      </ul>
    </DateViewContext.Provider>
  )
}
