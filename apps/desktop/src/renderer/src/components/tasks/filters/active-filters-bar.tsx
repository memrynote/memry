import { useMemo } from 'react'

import { X, Star } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { TaskFilters, Project } from '@/data/tasks-data'
import type { Priority } from '@/data/sample-tasks'

interface ActiveFiltersBarProps {
  filters: TaskFilters
  projects: Project[]
  onUpdateFilters: (updates: Partial<TaskFilters>) => void
  onClearAll: () => void
  onSaveFilter?: () => void
  isSaved?: boolean
  className?: string
}

const DUE_DATE_LABELS: Record<string, string> = {
  overdue: 'Overdue',
  today: 'Today',
  tomorrow: 'Tomorrow',
  'this-week': 'This Week',
  'next-week': 'Next Week',
  none: 'No due date',
  'this-month': 'This Month',
  custom: 'Custom'
}

const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'None'
}

const RemoveButton = ({
  onClick,
  label
}: {
  onClick: () => void
  label: string
}): React.JSX.Element => (
  <button
    type="button"
    onClick={onClick}
    aria-label={`Remove ${label} filter`}
    className="flex items-center justify-center shrink-0 rounded-[3px] size-4 hover:opacity-70 transition-opacity"
  >
    <X size={10} className="text-text-tertiary" />
  </button>
)

const PillWrapper = ({
  children,
  className: cls
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element => (
  <div
    className={cn(
      'flex items-center rounded-[5px] pr-1 pl-2 gap-[5px] shrink-0 py-[3px] antialiased',
      'bg-[#5E6AD21A] border border-[#5E6AD233]',
      cls
    )}
  >
    {children}
  </div>
)

export const ActiveFiltersBar = ({
  filters,
  projects,
  onUpdateFilters,
  onClearAll,
  onSaveFilter,
  isSaved = false,
  className
}: ActiveFiltersBarProps): React.JSX.Element | null => {
  const pills = useMemo(() => {
    const result: React.ReactNode[] = []

    if (filters.priorities.length > 0) {
      const values = filters.priorities.map((p) => PRIORITY_LABELS[p]).join(', ')
      result.push(
        <PillWrapper key="priority">
          <svg
            width="11"
            height="11"
            viewBox="0 0 11 11"
            fill="none"
            className="text-muted-foreground shrink-0"
          >
            <rect x="1" y="6" width="2" height="4" rx="0.4" fill="currentColor" />
            <rect x="4.5" y="4" width="2" height="6" rx="0.4" fill="currentColor" />
            <rect x="8" y="2" width="2" height="8" rx="0.4" fill="currentColor" />
          </svg>
          <span
            className={`text-[11px] text-text-secondary leading-3.5 shrink-0 whitespace-nowrap`}
          >
            Priority is
          </span>
          <span
            className={`text-[11px] text-foreground font-medium leading-3.5 shrink-0 whitespace-nowrap`}
          >
            {values}
          </span>
          <RemoveButton label="priority" onClick={() => onUpdateFilters({ priorities: [] })} />
        </PillWrapper>
      )
    }

    if (filters.statusIds.length > 0) {
      const statusNames = filters.statusIds.map((id) => {
        for (const project of projects) {
          const status = project.statuses.find((s) => s.id === id)
          if (status) return status.name
        }
        return id
      })
      result.push(
        <PillWrapper key="status">
          <svg
            width="11"
            height="11"
            viewBox="0 0 11 11"
            fill="none"
            className="text-muted-foreground shrink-0"
          >
            <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1" />
          </svg>
          <span
            className={`text-[11px] text-text-secondary leading-3.5 shrink-0 whitespace-nowrap`}
          >
            Status is
          </span>
          <span
            className={`text-[11px] text-foreground font-medium leading-3.5 shrink-0 whitespace-nowrap`}
          >
            {statusNames.join(', ')}
          </span>
          <RemoveButton label="status" onClick={() => onUpdateFilters({ statusIds: [] })} />
        </PillWrapper>
      )
    }

    if (filters.projectIds.length > 0) {
      const projectEntries = filters.projectIds
        .map((id) => projects.find((p) => p.id === id))
        .filter(Boolean) as Project[]
      const names = projectEntries.map((p) => p.name).join(', ')
      const firstColor = projectEntries[0]?.color
      result.push(
        <PillWrapper key="project">
          {firstColor && (
            <div
              className="w-[7px] h-[7px] shrink-0 rounded-xs"
              style={{ backgroundColor: firstColor }}
            />
          )}
          <span
            className={`text-[11px] text-text-secondary leading-3.5 shrink-0 whitespace-nowrap`}
          >
            Project is
          </span>
          <span
            className={`text-[11px] text-foreground font-medium leading-3.5 shrink-0 whitespace-nowrap`}
          >
            {names || 'Unknown'}
          </span>
          <RemoveButton label="project" onClick={() => onUpdateFilters({ projectIds: [] })} />
        </PillWrapper>
      )
    }

    if (filters.dueDate.type !== 'any') {
      let label = DUE_DATE_LABELS[filters.dueDate.type] || filters.dueDate.type
      if (
        filters.dueDate.type === 'custom' &&
        filters.dueDate.customStart &&
        filters.dueDate.customEnd
      ) {
        const fmt = (d: Date | string): string =>
          (d instanceof Date ? d : new Date(d)).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric'
          })
        label = `${fmt(filters.dueDate.customStart)} – ${fmt(filters.dueDate.customEnd)}`
      }
      result.push(
        <PillWrapper key="dueDate">
          <svg
            width="11"
            height="11"
            viewBox="0 0 11 11"
            fill="none"
            className="text-muted-foreground shrink-0"
          >
            <rect
              x="1"
              y="2"
              width="9"
              height="7.5"
              rx="1.2"
              stroke="currentColor"
              strokeWidth="0.9"
            />
            <path d="M1 4.5h9" stroke="currentColor" strokeWidth="0.9" />
          </svg>
          <span
            className={`text-[11px] text-text-secondary leading-3.5 shrink-0 whitespace-nowrap`}
          >
            Due
          </span>
          <span
            className={`text-[11px] text-foreground font-medium leading-3.5 shrink-0 whitespace-nowrap`}
          >
            {label}
          </span>
          <RemoveButton
            label="due date"
            onClick={() =>
              onUpdateFilters({ dueDate: { type: 'any', customStart: null, customEnd: null } })
            }
          />
        </PillWrapper>
      )
    }

    if (filters.search) {
      result.push(
        <PillWrapper key="search">
          <svg
            width="11"
            height="11"
            viewBox="0 0 11 11"
            fill="none"
            className="text-muted-foreground shrink-0"
          >
            <circle cx="4.5" cy="4.5" r="3.5" stroke="currentColor" strokeWidth="0.9" />
            <path d="M7 7l2.5 2.5" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" />
          </svg>
          <span
            className={`text-[11px] text-foreground font-medium leading-3.5 shrink-0 whitespace-nowrap`}
          >
            "{filters.search}"
          </span>
          <RemoveButton label="search" onClick={() => onUpdateFilters({ search: '' })} />
        </PillWrapper>
      )
    }

    return result
  }, [filters, projects, onUpdateFilters])

  if (pills.length === 0) return null

  return (
    <div
      className={cn(
        'flex items-center py-2 px-4 gap-2 flex-nowrap w-full',
        'bg-popover border-x border-b border-border rounded-b-lg',
        className
      )}
    >
      {pills}
      <div className="flex items-center gap-2.5 ml-auto shrink-0">
        {onSaveFilter && (
          <button
            type="button"
            onClick={onSaveFilter}
            aria-label={isSaved ? 'Saved' : 'Save filter'}
            className="flex items-center gap-1 text-[11px] shrink-0 whitespace-nowrap text-text-secondary leading-3.5 hover:text-foreground transition-colors"
          >
            <Star size={11} className="shrink-0" fill={isSaved ? 'currentColor' : 'none'} />
            <span>{isSaved ? 'Saved' : 'Save'}</span>
          </button>
        )}
        <button
          type="button"
          onClick={onClearAll}
          className="text-[11px] shrink-0 whitespace-nowrap text-destructive leading-3.5 hover:text-destructive/70 transition-colors"
        >
          Clear all
        </button>
      </div>
    </div>
  )
}

export default ActiveFiltersBar
