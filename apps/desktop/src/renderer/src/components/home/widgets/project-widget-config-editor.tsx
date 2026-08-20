import type React from 'react'
import { useT } from '@memry/i18n/renderer'
import { useTasksContext } from '@/contexts/tasks'
import { ProjectSelect } from '@/components/tasks/project-select'
import type { WidgetConfigEditorProps } from '@/lib/home/widget-registry'
import { readProjectId } from './project-widget-config'

/** Picks which project the widget is pinned to — the Folder widget's `folderPath` pattern. */
export function ProjectWidgetConfigEditor({
  config,
  onChange
}: WidgetConfigEditorProps): React.JSX.Element {
  const { t } = useT('common')
  const { projects } = useTasksContext()
  const projectId = readProjectId(config)

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">
        {t('home.widget.projectLabel')}
      </span>
      <span data-testid="project-widget-select">
        <ProjectSelect
          value={projectId}
          onChange={(value) => onChange({ ...config, projectId: value })}
          projects={projects.filter((project) => !project.isArchived)}
        />
      </span>
    </label>
  )
}
