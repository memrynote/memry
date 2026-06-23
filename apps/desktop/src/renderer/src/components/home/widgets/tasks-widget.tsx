import type React from 'react'
import { useMemo } from 'react'
import { useTaskWorkspaceData, useTaskWorkspaceMutations } from '@/features/tasks/use-task-queries'
import { getFilteredTasks } from '@/lib/task-utils/task-view-helpers'
import { applyFiltersAndSort } from '@/lib/task-utils/task-filters'
import { useSavedFilters } from '@/hooks/use-task-filters'
import { useTabActions } from '@/contexts/tabs/context'
import { TaskRow } from '@/components/tasks/task-row'
import { defaultSort, type Project } from '@/data/tasks-data'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import { Skeleton } from '@/components/ui/skeleton'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useT } from '@memry/i18n/renderer'

export function TasksWidget({ config, size }: WidgetComponentProps): React.JSX.Element {
  const { t } = useT('common')
  const limit = size === 'L' ? 12 : size === 'M' ? 6 : 3
  const { tasks, projects, isLoading, error } = useTaskWorkspaceData({ enabled: true })
  const { updateTask } = useTaskWorkspaceMutations()
  const { openTab } = useTabActions()
  const { savedFilters } = useSavedFilters()

  const dateRange = typeof config.dateRange === 'string' ? config.dateRange : 'today'
  const projectId = typeof config.projectId === 'string' ? config.projectId : null
  const selectedId = projectId ?? dateRange
  const selectedType = projectId ? 'project' : 'view'

  const savedFilterId = typeof config.savedFilterId === 'string' ? config.savedFilterId : null
  const savedFilter = savedFilterId ? savedFilters.find((f) => f.id === savedFilterId) : null

  const filtered = useMemo(() => {
    if (savedFilter) {
      return applyFiltersAndSort(
        tasks,
        savedFilter.filters,
        savedFilter.sort ?? defaultSort,
        projects
      ).slice(0, limit)
    }
    return getFilteredTasks(tasks, selectedId, selectedType, projects).slice(0, limit)
  }, [savedFilter, tasks, projects, selectedId, selectedType, limit])

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
    return <div className="text-xs text-muted-foreground">{t('home.noTasksYet')}</div>

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
          <li key={task.id} data-testid="task-item" data-task-id={task.id}>
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
          </li>
        )
      })}
    </ul>
  )
}
