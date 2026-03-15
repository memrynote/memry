import { ActiveFiltersBar } from './active-filters-bar'
import { cn } from '@/lib/utils'
import type { TaskFilters, Project } from '@/data/tasks-data'
import { hasActiveFilters } from '@/lib/task-utils'

interface FilterBarProps {
  filters: TaskFilters
  projects: Project[]
  onUpdateFilters: (updates: Partial<TaskFilters>) => void
  onClearFilters: () => void
  className?: string
}

export const FilterBar = ({
  filters,
  projects,
  onUpdateFilters,
  onClearFilters,
  className
}: FilterBarProps): React.JSX.Element | null => {
  const isActive = hasActiveFilters(filters)

  if (!isActive) return null

  return (
    <div className={cn('border-b border-border/50', className)}>
      <ActiveFiltersBar
        filters={filters}
        projects={projects}
        onUpdateFilters={onUpdateFilters}
        onClearAll={onClearFilters}
      />
    </div>
  )
}

export default FilterBar
