import { useMemo } from 'react'
import { Search, Calendar, Repeat, Clock } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { FilterChip } from './filter-chip'
import { cn } from '@/lib/utils'
import type { TaskFilters, Project } from '@/data/tasks-data'
import { priorityConfig, type Priority } from '@/data/sample-tasks'
import { dueDateFilterOptions } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface ActiveFiltersBarProps {
  filters: TaskFilters
  projects: Project[]
  onUpdateFilters: (updates: Partial<TaskFilters>) => void
  onClearAll: () => void
  onSaveFilter?: () => void
  className?: string
}

interface ChipData {
  id: string
  label: string
  icon?: React.ReactNode
  color?: string
  onRemove: () => void
}

// ============================================================================
// PRIORITY COLORS
// ============================================================================

const priorityColors: Record<Priority, string> = {
  urgent: priorityConfig.urgent.color || '#ef4444',
  high: priorityConfig.high.color || '#f97316',
  medium: priorityConfig.medium.color || '#eab308',
  low: priorityConfig.low.color || '#6b7280',
  none: '#9ca3af'
}

// ============================================================================
// ACTIVE FILTERS BAR COMPONENT
// ============================================================================

export const ActiveFiltersBar = ({
  filters,
  projects,
  onUpdateFilters,
  onClearAll,
  onSaveFilter,
  className
}: ActiveFiltersBarProps): React.JSX.Element | null => {
  // Generate chips from active filters
  const chips = useMemo((): ChipData[] => {
    const result: ChipData[] = []

    // Search
    if (filters.search) {
      result.push({
        id: 'search',
        label: `"${filters.search}"`,
        icon: <Search className="size-3" />,
        onRemove: () => onUpdateFilters({ search: '' })
      })
    }

    // Projects - T032: Handle deleted projects gracefully
    filters.projectIds.forEach((projectId) => {
      const project = projects.find((p) => p.id === projectId)
      result.push({
        id: `project-${projectId}`,
        label: project?.name ?? 'Deleted Project',
        color: project?.color ?? '#9ca3af', // Gray for deleted projects
        onRemove: () =>
          onUpdateFilters({
            projectIds: filters.projectIds.filter((id) => id !== projectId)
          })
      })
    })

    // Priorities
    filters.priorities.forEach((priority) => {
      result.push({
        id: `priority-${priority}`,
        label: priority.charAt(0).toUpperCase() + priority.slice(1),
        color: priorityColors[priority],
        onRemove: () =>
          onUpdateFilters({
            priorities: filters.priorities.filter((p) => p !== priority)
          })
      })
    })

    // Due date
    if (filters.dueDate.type !== 'any') {
      let label = ''
      if (
        filters.dueDate.type === 'custom' &&
        filters.dueDate.customStart &&
        filters.dueDate.customEnd
      ) {
        const formatDate = (date: Date): string =>
          date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        label = `${formatDate(filters.dueDate.customStart)} - ${formatDate(filters.dueDate.customEnd)}`
      } else {
        const option = dueDateFilterOptions.find((o) => o.value === filters.dueDate.type)
        label = option?.label || filters.dueDate.type
      }

      result.push({
        id: 'dueDate',
        label,
        icon: <Calendar className="size-3" />,
        onRemove: () =>
          onUpdateFilters({
            dueDate: { type: 'any', customStart: null, customEnd: null }
          })
      })
    }

    // Status IDs
    filters.statusIds.forEach((statusId) => {
      // Find the status across all projects
      let statusName = statusId
      let statusColor = '#6b7280'
      for (const project of projects) {
        const status = project.statuses.find((s) => s.id === statusId)
        if (status) {
          statusName = status.name
          statusColor = status.color
          break
        }
      }

      result.push({
        id: `status-${statusId}`,
        label: statusName,
        color: statusColor,
        onRemove: () =>
          onUpdateFilters({
            statusIds: filters.statusIds.filter((id) => id !== statusId)
          })
      })
    })

    // Repeat type
    if (filters.repeatType !== 'all') {
      result.push({
        id: 'repeatType',
        label: filters.repeatType === 'repeating' ? 'Repeating' : 'One-time',
        icon: <Repeat className="size-3" />,
        onRemove: () => onUpdateFilters({ repeatType: 'all' })
      })
    }

    // Has time
    if (filters.hasTime !== 'all') {
      result.push({
        id: 'hasTime',
        label: filters.hasTime === 'with-time' ? 'With time' : 'No time',
        icon: <Clock className="size-3" />,
        onRemove: () => onUpdateFilters({ hasTime: 'all' })
      })
    }

    // Completion (only if not default "active")
    if (filters.completion !== 'active') {
      result.push({
        id: 'completion',
        label: filters.completion === 'completed' ? 'Completed' : 'All',
        onRemove: () => onUpdateFilters({ completion: 'active' })
      })
    }

    return result
  }, [filters, projects, onUpdateFilters])

  // Don't render if no chips
  if (chips.length === 0) return null

  return (
    <div className={cn('flex items-center gap-2 px-4 py-2 bg-muted/50 border-b', className)}>
      <span className="text-sm text-muted-foreground shrink-0">Active:</span>

      <div className="flex flex-wrap gap-2 flex-1 min-w-0">
        {chips.map((chip) => (
          <FilterChip
            key={chip.id}
            label={chip.label}
            icon={chip.icon}
            color={chip.color}
            onRemove={chip.onRemove}
          />
        ))}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {onSaveFilter && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSaveFilter}
            className="h-7 text-xs text-muted-foreground hover:text-foreground"
          >
            Save
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onClearAll}
          className="h-7 text-xs text-muted-foreground hover:text-foreground"
        >
          Clear all
        </Button>
      </div>
    </div>
  )
}

export default ActiveFiltersBar
