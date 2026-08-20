import { useCallback, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useTabActions } from '@/contexts/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { FolderKanban } from '@/lib/icons/icon-map'
import { useProjectHub, type ProjectTabKey } from '@/pages/project/use-project-hub'
import { DEFAULT_PROJECT_TAB, PROJECT_VIEW_STATE_KEYS } from '@/pages/project/project-view-state'
import { OverviewTab } from '@/pages/project/tabs/overview-tab'
import { ListTab } from '@/pages/project/tabs/list-tab'
import { TaskRow } from '@/pages/project/rows/task-row'
import { WidgetEmptyState } from './widget-list'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import { ProjectWidgetTabs } from './project-widget-header'
import { readProjectId } from './project-widget-config'
import { useProjectWidgetHandlers } from './use-project-widget-handlers'

export function ProjectWidget({ config }: WidgetComponentProps): React.JSX.Element {
  const { t } = useT('common')
  const { openTab } = useTabActions()
  const projectId = readProjectId(config)
  // Navigation, not a preference: switching tabs is deliberately NOT written back
  // to `config`, which is persisted and synced. It resets to Overview on restart.
  const [activeTab, setActiveTab] = useState<ProjectTabKey>(DEFAULT_PROJECT_TAB)

  const hub = useProjectHub(projectId || undefined)
  const project = hub.project

  const openProjectPage = useCallback(
    (tab: ProjectTabKey) => {
      if (!project) return
      openTab({
        type: 'project',
        title: project.name,
        icon: 'folder',
        path: `/project/${project.id}`,
        entityId: project.id,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false,
        viewState: { [PROJECT_VIEW_STATE_KEYS.projectTab]: tab }
      })
    },
    [openTab, project]
  )

  const handlers = useProjectWidgetHandlers({
    hub,
    onGoToTab: setActiveTab,
    onOpenProjectPage: openProjectPage
  })

  // Never configured. The config editor is one click away in the widget menu, and
  // the header already opens it on mount for a freshly added widget.
  if (!projectId)
    return <WidgetEmptyState icon={FolderKanban} label={t('home.widget.projectNoSelection')} />

  if (!project && hub.isLoading)
    return (
      <div className="flex flex-col gap-1" aria-busy="true" aria-label={t('state.loading')}>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    )

  // Configured, but the project is gone — deleted or archived on another device,
  // since boards sync. The widget says so and stays put: silently removing itself
  // would let one device rewrite the user's board behind their back.
  if (!project)
    return (
      <div data-testid="project-widget-missing">
        <WidgetEmptyState icon={FolderKanban} label={t('home.widget.projectMissing')} />
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectWidgetTabs active={activeTab} onChange={setActiveTab} counts={hub.counts} />

      <div className="min-h-0 flex-1">
        {activeTab === 'overview' ? (
          <OverviewTab project={project} hub={hub} handlers={handlers} />
        ) : activeTab === 'tasks' ? (
          // Plain rows, not the page's `TaskList`: that list is virtualized and
          // sizes itself with `flex-1` + `contain: strict`, which collapses to zero
          // height inside the frame's scroll container and renders no rows at all.
          <ul className="flex flex-col">
            {hub.tasks.length === 0 ? (
              <WidgetEmptyState icon={FolderKanban} label={t('home.widget.projectNoTasks')} />
            ) : (
              hub.tasks.map((task) => (
                <li key={task.id}>
                  <TaskRow
                    task={task}
                    project={project}
                    onOpen={handlers.onOpenTask}
                    onStatusChange={handlers.onStatusChange}
                    onToggleComplete={handlers.onToggleComplete}
                    onPriorityChange={handlers.onPriorityChange}
                  />
                </li>
              ))
            )}
          </ul>
        ) : (
          <ListTab kind={activeTab} hub={hub} handlers={handlers} />
        )}
      </div>
    </div>
  )
}
