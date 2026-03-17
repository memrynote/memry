import { Search } from '@/lib/icons'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { TaskFilters, Project } from '@/data/tasks-data'
import { dueDateFilterOptions } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface FilterEmptyStateProps {
  filters: TaskFilters
  projects: Project[]
  onClearFilters: () => void
  className?: string
}

// ============================================================================
// FILTER EMPTY STATE COMPONENT
// ============================================================================

export const FilterEmptyState = ({
  filters,
  projects,
  onClearFilters,
  className
}: FilterEmptyStateProps): React.JSX.Element => {
  // Generate a summary of active filters
  const getFilterSummary = (): string => {
    const parts: string[] = []

    // Search
    if (filters.search) {
      parts.push(`"${filters.search}"`)
    }

    // Projects
    if (filters.projectIds.length > 0) {
      const projectNames = filters.projectIds
        .map((id) => projects.find((p) => p.id === id)?.name)
        .filter(Boolean)
      if (projectNames.length > 0) {
        parts.push(projectNames.join(', '))
      }
    }

    // Priorities
    if (filters.priorities.length > 0) {
      const priorityLabels = filters.priorities.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      parts.push(priorityLabels.join(', '))
    }

    // Due date
    if (filters.dueDate.type !== 'any') {
      const option = dueDateFilterOptions.find((o) => o.value === filters.dueDate.type)
      if (option) {
        parts.push(option.label)
      }
    }

    // Repeat type
    if (filters.repeatType !== 'all') {
      parts.push(filters.repeatType === 'repeating' ? 'Repeating' : 'One-time')
    }

    return parts.join(' · ')
  }

  const filterSummary = getFilterSummary()

  return (
    <div className={cn('flex flex-col items-center justify-center py-16 px-4', className)}>
      <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-6">
        <Search className="size-8 text-muted-foreground" />
      </div>

      <h3 className="text-lg font-medium text-foreground mb-2">No tasks match your filters</h3>

      {filterSummary && (
        <p className="text-sm text-muted-foreground mb-6 text-center max-w-md">
          Active filters: {filterSummary}
        </p>
      )}

      <p className="text-sm text-muted-foreground mb-4">Try adjusting your filters or</p>

      <Button variant="outline" onClick={onClearFilters} className="text-primary">
        Clear all filters
      </Button>
    </div>
  )
}

export default FilterEmptyState
