import type React from 'react'
import { useTasksContext } from '@/contexts/tasks'
import { ProjectPicker } from '@/components/tasks/project-picker'
import type { WidgetConfigEditorProps } from '@/lib/home/widget-registry'
import { readProjectId } from './project-widget-config'

/**
 * Which project the widget is pinned to, chosen from the widget header — the
 * Folder widget's pattern, where the header pill both names the thing on show
 * and is how you change it. The badge trigger carries the project's colour and
 * name, so several project widgets side by side stay tellable apart.
 *
 * A header slot is the right home for this and NOT for the tab strip: slots only
 * receive `config`, which is persisted and synced, and the pinned project is
 * exactly that kind of stored choice.
 */
export function ProjectWidgetPicker({
  config,
  onChange
}: WidgetConfigEditorProps): React.JSX.Element {
  const { projects } = useTasksContext()
  const projectId = readProjectId(config)

  return (
    <span className="widget-no-drag" data-testid="project-widget-picker">
      <ProjectPicker
        value={projectId || null}
        onChange={(id) => onChange({ ...config, projectId: id ?? '' })}
        projects={projects.filter((project) => !project.isArchived)}
        triggerVariant="badge"
        searchable
        allowCreate={false}
      />
    </span>
  )
}
