import * as React from 'react'

import { cn } from '@/lib/utils'
import { Picker } from '@/components/ui/picker'
import type { Project } from '@/data/tasks-data'

interface InteractiveProjectBadgeProps {
  projectId: string
  projects: Project[]
  onProjectChange: (projectId: string) => void
  className?: string
}

export type { InteractiveProjectBadgeProps }

export const InteractiveProjectBadge = ({
  projectId,
  projects,
  onProjectChange,
  className
}: InteractiveProjectBadgeProps): React.JSX.Element => {
  const currentProject = projects.find((p) => p.id === projectId)
  const projectColor = currentProject?.color || '#6B7280'
  const projectName = currentProject?.name || 'No project'

  const availableProjects = React.useMemo(() => projects.filter((p) => !p.isArchived), [projects])

  return (
    <Picker
      value={projectId}
      onValueChange={(val) => {
        if (val !== projectId) onProjectChange(val)
      }}
    >
      <Picker.Trigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center rounded-sm py-0.5 px-2 gap-1.5 cursor-pointer transition-opacity',
            'hover:opacity-80 focus-visible:outline-none',
            className
          )}
          style={{ backgroundColor: `${projectColor}14` }}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Project: ${projectName}. Click to change.`}
        >
          <div className="rounded-xs shrink-0 size-2" style={{ backgroundColor: projectColor }} />
          <div className="text-[11px] font-medium leading-3.5" style={{ color: projectColor }}>
            {projectName}
          </div>
        </button>
      </Picker.Trigger>
      <Picker.Content width="auto" align="start" sideOffset={4}>
        <Picker.List>
          {availableProjects.map((proj) => (
            <Picker.Item
              key={proj.id}
              value={proj.id}
              label={proj.name}
              icon={
                <div
                  className="rounded-xs shrink-0 size-2"
                  style={{ backgroundColor: proj.color }}
                />
              }
              indicator="check"
              indicatorColor={proj.color}
            />
          ))}
        </Picker.List>
      </Picker.Content>
    </Picker>
  )
}
