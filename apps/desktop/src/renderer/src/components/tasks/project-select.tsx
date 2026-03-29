import { useMemo } from 'react'
import { getIconByName } from '@/components/icon-picker'
import { cn } from '@/lib/utils'
import { Picker } from '@/components/ui/picker'
import type { Project } from '@/data/tasks-data'

interface ProjectSelectProps {
  value: string
  onChange: (value: string) => void
  projects: Project[]
  className?: string
}

const ProjectIndicator = ({ project }: { project: Project }): React.JSX.Element => {
  const IconComponent = getIconByName(project.icon)

  if (IconComponent) {
    return (
      <IconComponent
        className="size-4 shrink-0"
        style={{ color: project.color }}
        aria-hidden="true"
      />
    )
  }

  return (
    <span
      className="size-3 shrink-0 rounded-full"
      style={{ backgroundColor: project.color }}
      aria-hidden="true"
    />
  )
}

export const ProjectSelect = ({
  value,
  onChange,
  projects,
  className
}: ProjectSelectProps): React.JSX.Element => {
  const availableProjects = useMemo(() => projects.filter((p) => !p.isArchived), [projects])
  const currentProject = availableProjects.find((p) => p.id === value)

  return (
    <Picker value={value} onValueChange={onChange}>
      <Picker.Trigger
        variant="button"
        chevron
        className={cn('w-full', className)}
        aria-label="Select project"
      >
        {currentProject ? (
          <span className="flex items-center gap-2 min-w-0">
            <ProjectIndicator project={currentProject} />
            <span className="truncate">{currentProject.name}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">Select project</span>
        )}
      </Picker.Trigger>
      <Picker.Content width="trigger" align="start">
        <Picker.List>
          {availableProjects.map((project) => (
            <Picker.Item
              key={project.id}
              value={project.id}
              label={project.name}
              icon={<ProjectIndicator project={project} />}
              indicator="check"
              indicatorColor={project.color}
            />
          ))}
        </Picker.List>
      </Picker.Content>
    </Picker>
  )
}

export default ProjectSelect
