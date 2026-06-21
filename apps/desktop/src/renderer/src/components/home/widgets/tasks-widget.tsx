import type React from 'react'
import { useMemo } from 'react'
import { useTaskWorkspaceData } from '@/features/tasks/use-task-queries'
import { getFilteredTasks } from '@/lib/task-utils/task-view-helpers'
import { useTabActions } from '@/contexts/tabs/context'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import { useT } from '@memry/i18n/renderer'

export function TasksWidget({ config, size }: WidgetComponentProps): React.JSX.Element {
  const { t } = useT('common')
  const limit = size === 'L' ? 12 : size === 'M' ? 6 : 3
  const { tasks, projects, isLoading } = useTaskWorkspaceData({ enabled: true })
  const { openTab } = useTabActions()

  const dateRange = typeof config.dateRange === 'string' ? config.dateRange : 'today'
  const projectId = typeof config.projectId === 'string' ? config.projectId : null
  const selectedId = projectId ?? dateRange
  const selectedType = projectId ? 'project' : 'view'

  const filtered = useMemo(
    () => getFilteredTasks(tasks, selectedId, selectedType, projects).slice(0, limit),
    [tasks, projects, selectedId, selectedType, limit]
  )

  if (isLoading) return <div className="text-xs text-muted-foreground">{t('state.loading')}</div>

  if (filtered.length === 0)
    return <div className="text-xs text-muted-foreground">{t('home.noTasksYet')}</div>

  return (
    <ul className="flex flex-col gap-1">
      {filtered.map((task) => (
        <li key={task.id}>
          <button
            type="button"
            data-testid="task-item"
            data-task-id={task.id}
            className="w-full truncate text-start text-sm hover:underline"
            onClick={() =>
              openTab({
                type: 'tasks',
                title: task.title || t('home.widget.untitled'),
                icon: 'check-square',
                path: '/tasks',
                entityId: task.id,
                isPinned: false,
                isModified: false,
                isDeleted: false,
                isPreview: true
              })
            }
          >
            {task.title || t('home.widget.untitled')}
          </button>
        </li>
      ))}
    </ul>
  )
}
