import * as React from 'react'

import { cn } from '@/lib/utils'
import { StatusDot } from '@/components/ui/status-dot'
import { CheckMark } from '@/components/ui/check-mark'
import { FilterSearchHeader } from '@/components/ui/filter-search-header'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Project } from '@/data/tasks-data'
import { ProjectBadge } from './task-badges'

interface InteractiveProjectBadgeProps {
  project: Project
  projects: Project[]
  onProjectChange: (projectId: string) => void
  fixedWidth?: boolean
  className?: string
}

export const InteractiveProjectBadge = ({
  project,
  projects,
  onProjectChange,
  fixedWidth = false,
  className
}: InteractiveProjectBadgeProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = React.useState(false)
  const [projectSearch, setProjectSearch] = React.useState('')

  const activeProjects = projects.filter((p) => !p.isArchived)
  const filteredProjects = projectSearch
    ? activeProjects.filter((p) => p.name.toLowerCase().includes(projectSearch.toLowerCase()))
    : activeProjects

  if (!projects || projects.length === 0) {
    return <ProjectBadge project={project} fixedWidth={fixedWidth} className={className} />
  }

  const handleSelect = (projectId: string): void => {
    onProjectChange(projectId)
    setIsOpen(false)
    setProjectSearch('')
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
            'flex items-center rounded-sm py-0.5 px-2 gap-1 cursor-pointer transition-opacity',
            'hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            fixedWidth && 'w-[120px] justify-start',
            className
          )}
          style={{ backgroundColor: `${project.color}0F` }}
          aria-label={`Project: ${project.name}. Click to change.`}
        >
          <StatusDot color={project.color} size="xs" />
          <div
            className="text-[11px] font-medium leading-3.5 truncate"
            style={{ color: project.color }}
          >
            {project.name}
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[200px] p-0 rounded-[10px] bg-popover border-border shadow-lg"
        align="start"
        sideOffset={4}
        onClick={handleTriggerClick}
      >
        <div className="flex flex-col p-1 [font-synthesis:none] antialiased">
          <FilterSearchHeader
            value={projectSearch}
            onChange={setProjectSearch}
            placeholder="Search projects..."
            className="mb-1 py-2 px-3 gap-1.5"
          />
          {filteredProjects.map((p) => {
            const isSelected = p.id === project.id
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => handleSelect(p.id)}
                className={cn(
                  'flex items-center rounded-[7px] py-2 px-3 gap-2 transition-colors',
                  'hover:bg-accent focus:outline-none'
                )}
                style={isSelected ? { backgroundColor: `${p.color}0F` } : undefined}
              >
                <StatusDot color={p.color} size="xs" />
                <div
                  className={cn(
                    'text-[13px] leading-4',
                    isSelected ? 'font-medium' : 'text-text-secondary'
                  )}
                  style={isSelected ? { color: p.color } : undefined}
                >
                  {p.name}
                </div>
                {isSelected && <CheckMark color={p.color} className="ml-auto" />}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
