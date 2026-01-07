import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { getIconByName } from '@/components/icon-picker'
import { cn } from '@/lib/utils'
import type { Project } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface ProjectSelectProps {
  value: string
  onChange: (value: string) => void
  projects: Project[]
  className?: string
}

// ============================================================================
// PROJECT INDICATOR COMPONENT
// ============================================================================

const ProjectIndicator = ({
  project,
  className
}: {
  project: Project
  className?: string
}): React.JSX.Element => {
  const IconComponent = getIconByName(project.icon)

  if (IconComponent) {
    return (
      <IconComponent
        className={cn('size-4 shrink-0', className)}
        style={{ color: project.color }}
        aria-hidden="true"
      />
    )
  }

  return (
    <span
      className={cn('size-3 shrink-0 rounded-full', className)}
      style={{ backgroundColor: project.color }}
      aria-hidden="true"
    />
  )
}

// ============================================================================
// PROJECT SELECT COMPONENT
// ============================================================================

export const ProjectSelect = ({
  value,
  onChange,
  projects,
  className
}: ProjectSelectProps): React.JSX.Element => {
  // Filter out archived projects
  const availableProjects = projects.filter((p) => !p.isArchived)

  // Find current project
  const currentProject = availableProjects.find((p) => p.id === value)

  const handleValueChange = (newValue: string): void => {
    onChange(newValue)
  }

  return (
    <Select value={value} onValueChange={handleValueChange}>
      <SelectTrigger className={cn('w-full', className)} aria-label="Select project">
        <SelectValue>
          {currentProject ? (
            <div className="flex items-center gap-2">
              <ProjectIndicator project={currentProject} />
              <span className="truncate">{currentProject.name}</span>
            </div>
          ) : (
            <span className="text-muted-foreground">Select project</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {availableProjects.map((project) => (
          <SelectItem key={project.id} value={project.id} className="cursor-pointer">
            <div className="flex items-center gap-2">
              <ProjectIndicator project={project} />
              <span className="truncate">{project.name}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export default ProjectSelect
