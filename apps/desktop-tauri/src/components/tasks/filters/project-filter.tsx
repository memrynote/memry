import { useState, useMemo } from 'react'
import { ChevronDown, Check } from '@/lib/icons'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { Project } from '@/data/tasks-data'
import { getIconByName } from '@/components/icon-picker'

// ============================================================================
// TYPES
// ============================================================================

interface ProjectFilterProps {
  projects: Project[]
  selectedIds: string[]
  onChange: (projectIds: string[]) => void
  taskCountByProject?: Record<string, number>
  className?: string
}

// ============================================================================
// PROJECT FILTER COMPONENT
// ============================================================================

export const ProjectFilter = ({
  projects,
  selectedIds,
  onChange,
  taskCountByProject = {},
  className
}: ProjectFilterProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false)

  const visibleProjects = useMemo(() => projects.filter((p) => !p.isArchived), [projects])

  const allSelected = selectedIds.length === 0
  const hasSelection = selectedIds.length > 0

  const handleToggleAll = (): void => {
    onChange([])
  }

  const handleToggleProject = (projectId: string): void => {
    const nextSelection = selectedIds.includes(projectId)
      ? selectedIds.filter((id) => id !== projectId)
      : [...selectedIds, projectId]
    onChange(nextSelection)
  }

  const handleClear = (): void => {
    onChange([])
  }

  const handleOpenChange = (open: boolean): void => {
    setIsOpen(open)
  }

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('h-9 gap-2', hasSelection && 'border-primary bg-primary/5', className)}
          aria-label="Filter by project"
        >
          <span>Project</span>
          {hasSelection && (
            <span className="bg-primary text-primary-foreground text-xs px-1.5 py-0.5 rounded-full min-w-5 text-center">
              {selectedIds.length}
            </span>
          )}
          <ChevronDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-56 p-0" align="start">
        <div className="p-2">
          {/* All Projects option */}
          <button
            type="button"
            onClick={handleToggleAll}
            className={cn(
              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors',
              'hover:bg-accent focus:outline-none focus:bg-accent',
              allSelected && 'font-medium'
            )}
          >
            <span className="flex items-center justify-center size-4">
              {allSelected && <Check className="size-4 text-primary" />}
            </span>
            <span>All Projects</span>
          </button>

          <div className="my-2 h-px bg-border" />

          {/* Individual projects */}
          <div className="max-h-64 overflow-y-auto">
            {visibleProjects.map((project) => {
              const isSelected = selectedIds.includes(project.id)
              const taskCount = taskCountByProject[project.id] || project.taskCount || 0
              const IconComponent = getIconByName(project.icon)

              return (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => handleToggleProject(project.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors',
                    'hover:bg-accent focus:outline-none focus:bg-accent',
                    isSelected && 'font-medium'
                  )}
                >
                  <span className="flex items-center justify-center size-4">
                    {isSelected && <Check className="size-4 text-primary" />}
                  </span>
                  <span className="flex items-center gap-2 flex-1 min-w-0">
                    {IconComponent ? (
                      <IconComponent className="size-4 shrink-0" style={{ color: project.color }} />
                    ) : (
                      <span
                        className="size-3 shrink-0 rounded-full"
                        style={{ backgroundColor: project.color }}
                      />
                    )}
                    <span className="truncate">{project.name}</span>
                  </span>
                  <span className="text-xs text-text-tertiary shrink-0">{taskCount}</span>
                </button>
              )
            })}
          </div>

          <div className="my-2 h-px bg-border" />

          {/* Action buttons */}
          <div className="flex items-center justify-end px-2 py-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClear}
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default ProjectFilter
