import * as React from 'react'

import { cn } from '@/lib/utils'
import { CheckMark } from '@/components/ui/check-mark'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
  const [isOpen, setIsOpen] = React.useState(false)

  const currentProject = projects.find((p) => p.id === projectId)
  const projectColor = currentProject?.color || '#6B7280'
  const projectName = currentProject?.name || 'No project'

  const availableProjects = React.useMemo(() => projects.filter((p) => !p.isArchived), [projects])

  const handleSelect = (newProjectId: string): void => {
    if (newProjectId === projectId) {
      setIsOpen(false)
      return
    }
    onProjectChange(newProjectId)
    setIsOpen(false)
  }

  const handleTriggerClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild onClick={handleTriggerClick}>
        <button
          type="button"
          className={cn(
            'flex items-center rounded-sm py-0.5 px-2 gap-1.5 cursor-pointer transition-opacity',
            'hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            className
          )}
          style={{ backgroundColor: `${projectColor}14` }}
          aria-label={`Project: ${projectName}. Click to change.`}
        >
          <div className="rounded-xs shrink-0 size-2" style={{ backgroundColor: projectColor }} />
          <div className="text-[11px] font-medium leading-3.5" style={{ color: projectColor }}>
            {projectName}
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 rounded-[10px] bg-popover border-border shadow-lg"
        align="start"
        sideOffset={4}
        onClick={handleTriggerClick}
      >
        <div className="flex flex-col p-1 [font-synthesis:none] antialiased">
          {availableProjects.map((proj) => {
            const isSelected = proj.id === projectId
            return (
              <button
                key={proj.id}
                type="button"
                onClick={() => handleSelect(proj.id)}
                className={cn(
                  'flex items-center rounded-[7px] py-2 px-3 gap-2 transition-colors',
                  'hover:bg-accent focus:outline-none'
                )}
                style={isSelected ? { backgroundColor: `${proj.color}0F` } : undefined}
              >
                <div
                  className="rounded-xs shrink-0 size-2"
                  style={{ backgroundColor: proj.color }}
                />
                <div
                  className={cn(
                    'text-[13px] leading-4',
                    isSelected ? 'font-medium' : 'text-text-secondary'
                  )}
                  style={isSelected ? { color: proj.color } : undefined}
                >
                  {proj.name}
                </div>
                {isSelected && <CheckMark color={proj.color} className="ml-auto" />}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
