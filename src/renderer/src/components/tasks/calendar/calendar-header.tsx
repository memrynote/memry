import React from 'react'
import { ChevronLeft, ChevronRight, Filter } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { Project } from '@/data/tasks-data'

interface CalendarHeaderProps {
  currentMonth: Date
  onPreviousMonth: () => void
  onNextMonth: () => void
  onToday: () => void
  showCompleted: boolean
  onToggleCompleted: (value: boolean) => void
  projects?: Project[]
  projectFilter: string | null
  onProjectFilterChange: (projectId: string | null) => void
}

export const CalendarHeader = ({
  currentMonth,
  onPreviousMonth,
  onNextMonth,
  onToday,
  showCompleted,
  onToggleCompleted,
  projects,
  projectFilter,
  onProjectFilterChange
}: CalendarHeaderProps): React.JSX.Element => {
  const monthLabel = currentMonth.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric'
  })

  const selectedProject = projects?.find((p) => p.id === projectFilter)

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-1 pb-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onPreviousMonth} aria-label="Previous month">
          <ChevronLeft className="size-4" />
        </Button>

        <div className={cn('text-lg font-semibold')}>{monthLabel}</div>

        <Button variant="ghost" size="icon" onClick={onNextMonth} aria-label="Next month">
          <ChevronRight className="size-4" />
        </Button>

        <Button variant="outline" size="sm" onClick={onToday}>
          Today
        </Button>
      </div>

      <div className="flex items-center gap-4">
        {/* Project Filter (only shown when projects prop is provided) */}
        {projects && projects.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <Filter className="size-3.5" />
                {selectedProject ? selectedProject.name : 'All Projects'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuCheckboxItem
                checked={projectFilter === null}
                onCheckedChange={() => onProjectFilterChange(null)}
              >
                All Projects
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              {projects
                .filter((p) => !p.isArchived)
                .map((project) => (
                  <DropdownMenuCheckboxItem
                    key={project.id}
                    checked={projectFilter === project.id}
                    onCheckedChange={() => onProjectFilterChange(project.id)}
                  >
                    <span
                      className="mr-2 inline-block size-2 rounded-full"
                      style={{ backgroundColor: project.color }}
                    />
                    {project.name}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={showCompleted}
            onCheckedChange={(checked) => onToggleCompleted(!!checked)}
          />
          Show completed
        </label>
      </div>
    </div>
  )
}

export default CalendarHeader
