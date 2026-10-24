import { ProjectPicker } from './project-picker'
import { cn } from '@/lib/utils'
import type { Project } from '@/data/tasks-data'

interface ProjectSelectProps {
  value: string
  onChange: (value: string) => void
  projects: Project[]
  className?: string
}

/**
 * Thin adapter over {@link ProjectPicker} (button variant). Kept for its narrower
 * string-only API used by the add-task form; all list/search/create logic lives in
 * ProjectPicker.
 */
export const ProjectSelect = ({
  value,
  onChange,
  projects,
  className
}: ProjectSelectProps): React.JSX.Element => (
  <ProjectPicker
    value={value}
    onChange={(id) => onChange(id ?? '')}
    projects={projects}
    triggerVariant="button"
    contentWidth="trigger"
    className={cn('w-full', className)}
  />
)

export default ProjectSelect
