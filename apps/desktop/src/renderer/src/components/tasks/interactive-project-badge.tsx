import { ProjectPicker } from './project-picker'
import type { Project } from '@/data/tasks-data'

interface InteractiveProjectBadgeProps {
  projectId: string
  projects: Project[]
  onProjectChange: (projectId: string) => void
  allowCreate?: boolean
  className?: string
}

export type { InteractiveProjectBadgeProps }

/**
 * Thin adapter over {@link ProjectPicker} (badge variant) — the inline project pill used
 * in task rows and the detail drawer. All list/search/create logic lives in ProjectPicker.
 */
export const InteractiveProjectBadge = ({
  projectId,
  projects,
  onProjectChange,
  allowCreate = false,
  className
}: InteractiveProjectBadgeProps): React.JSX.Element => (
  <ProjectPicker
    value={projectId}
    onChange={(id) => {
      if (id !== null) onProjectChange(id)
    }}
    projects={projects}
    triggerVariant="badge"
    allowCreate={allowCreate}
    className={className}
  />
)
