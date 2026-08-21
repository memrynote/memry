import type React from 'react'
import { useMemo } from 'react'
import { useTaskWorkspaceData, useTaskWorkspaceMutations } from '@/features/tasks/use-task-queries'
import { selectTasksForWidget } from '@/lib/home/tasks-widget-filter'
import { useSavedFilters } from '@/hooks/use-task-filters'
import { useTabActions } from '@/contexts/tabs/context'
import { TaskRow } from '@/components/tasks/task-row'
import { type Project } from '@/data/tasks-data'
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

  const filtered = useMemo(
    () => selectTasksForWidget(tasks, projects, savedFilters ?? [], config).slice(0, limit),
    [tasks, projects, savedFilters, config, limit]
  )

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

  if (filtered.length === 0)
    return <WidgetEmptyState icon={CheckSquare} label={t('home.noTasksYet')} />

  return (
    <ul className="flex flex-col gap-0.5">
      {filtered.map((task) => {
        const project =
          projects.find((p) => p.id === task.projectId) ??
          ({
            id: task.projectId,
            name: '',
            color: 'var(--text-tertiary)',
            statuses: []
          } as unknown as Project)

        return (
          <WidgetRow key={task.id} data-testid="task-item" data-task-id={task.id}>
            <TaskRow
              task={task}
              project={project}
              projects={projects}
              isCompleted={task.completedAt != null}
              showProjectBadge
              onToggleComplete={(id) => {
                void updateTask(id, { completedAt: task.completedAt ? null : new Date() })
              }}
              onUpdateTask={(id, updates) => {
                void updateTask(id, updates)
              }}
              onClick={(id) => {
                openTab({
                  type: 'tasks',
                  title: task.title || t('home.widget.untitled'),
                  icon: 'check-square',
                  path: '/tasks',
                  entityId: id,
                  isPinned: false,
                  isModified: false,
                  isDeleted: false,
                  isPreview: true
                })
              }}
            />
          </WidgetRow>
        )
      })}
    </ul>
  )
}
