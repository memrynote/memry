import { ActiveFiltersBar } from './active-filters-bar'
import type { TaskFilters, Project } from '@/data/tasks-data'
import { hasActiveFilters } from '@/lib/task-utils'

interface FilterBarProps {
  filters: TaskFilters
  projects: Project[]
  onUpdateFilters: (updates: Partial<TaskFilters>) => void
  onClearFilters: () => void
  onSaveFilter?: () => void
  isSaved?: boolean
  className?: string
}

export const FilterBar = ({
  filters,
  projects,
  onUpdateFilters,
  onClearFilters,
  onSaveFilter,
  isSaved,
  className
}: FilterBarProps): React.JSX.Element | null => {
  const isActive = hasActiveFilters(filters)

  if (!isActive) return null

  return (
    <ActiveFiltersBar
      filters={filters}
      projects={projects}
      onUpdateFilters={onUpdateFilters}
      onClearAll={onClearFilters}
      onSaveFilter={onSaveFilter}
      isSaved={isSaved}
      className={className}
    />
  )
}

export default FilterBar
