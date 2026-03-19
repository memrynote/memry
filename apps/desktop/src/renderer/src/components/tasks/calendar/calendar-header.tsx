import React from 'react'
import { ChevronLeft, ChevronRight, Filter } from '@/lib/icons'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
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
    <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
      <div className="flex items-center gap-2">
        {/* Month navigation */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onPreviousMonth}
            aria-label="Previous month"
            className="flex items-center justify-center size-8 rounded-md text-cal-weekday hover:bg-cal-cell-outside-bg transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-4" />
          </button>

          <h2
            className="text-2xl font-semibold tracking-tight select-none min-w-[180px]"
            style={{
              color: 'var(--cal-month-text)',
              fontFamily: 'var(--font-heading)',
              letterSpacing: '-0.02em'
            }}
          >
            {monthLabel}
          </h2>

          <button
            type="button"
            onClick={onNextMonth}
            aria-label="Next month"
            className="flex items-center justify-center size-8 rounded-md text-cal-weekday hover:bg-cal-cell-outside-bg transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>

        {/* Today pill */}
        <button
          type="button"
          onClick={onToday}
          className="rounded-full px-3 py-1 text-xs font-medium bg-cal-cell-outside-bg text-cal-date-current hover:bg-cal-cell-weekend-bg transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          Today
        </button>
      </div>

      <div className="flex items-center gap-4">
        {/* Project Filter */}
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
