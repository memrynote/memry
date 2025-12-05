import { useState, useRef, useMemo, forwardRef, useImperativeHandle } from "react"
import { CheckSquare } from "lucide-react"

import { SearchInput } from "./search-input"
import { ProjectFilter } from "./project-filter"
import { PriorityFilter } from "./priority-filter"
import { DueDateFilter } from "./due-date-filter"
import { MoreFiltersDropdown } from "./more-filters-dropdown"
import { SortDropdown } from "./sort-dropdown"
import { ActiveFiltersBar } from "./active-filters-bar"
import { SavedFiltersDropdown } from "./saved-filters-dropdown"
import { SaveFilterDialog } from "./save-filter-dialog"
import { cn } from "@/lib/utils"
import type {
  TaskFilters,
  TaskSort,
  SavedFilter,
  Project,
  Status,
} from "@/data/tasks-data"
import { hasActiveFilters } from "@/lib/task-utils"
import type { Priority, Task } from "@/data/sample-tasks"

// ============================================================================
// TYPES
// ============================================================================

interface FilterBarProps {
  filters: TaskFilters
  sort: TaskSort
  onUpdateFilters: (updates: Partial<TaskFilters>) => void
  onUpdateSort: (sort: TaskSort) => void
  onClearFilters: () => void
  projects: Project[]
  tasks: Task[]
  savedFilters: SavedFilter[]
  onSaveFilter: (name: string, filters: TaskFilters, sort?: TaskSort) => void
  onDeleteSavedFilter: (filterId: string) => void
  onApplySavedFilter: (filter: SavedFilter) => void
  showStatusFilter?: boolean
  statuses?: Status[]
  /** Whether selection mode is active */
  isSelectionMode?: boolean
  /** Toggle selection mode on/off */
  onToggleSelectionMode?: () => void
  className?: string
}

export interface FilterBarRef {
  focusSearch: () => void
}

// ============================================================================
// FILTER BAR COMPONENT
// ============================================================================

export const FilterBar = forwardRef<FilterBarRef, FilterBarProps>(
  (
    {
      filters,
      sort,
      onUpdateFilters,
      onUpdateSort,
      onClearFilters,
      projects,
      tasks,
      savedFilters,
      onSaveFilter,
      onDeleteSavedFilter,
      onApplySavedFilter,
      showStatusFilter = false,
      statuses = [],
      isSelectionMode = false,
      onToggleSelectionMode,
      className,
    },
    ref
  ) => {
    const searchRef = useRef<HTMLInputElement>(null)
    const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false)

    // Expose focusSearch method to parent
    useImperativeHandle(ref, () => ({
      focusSearch: () => {
        searchRef.current?.focus()
      },
    }))

    const isActive = hasActiveFilters(filters)

    // Calculate task counts for filters
    const taskCountByProject = useMemo(() => {
      const counts: Record<string, number> = {}
      tasks.forEach((task) => {
        counts[task.projectId] = (counts[task.projectId] || 0) + 1
      })
      return counts
    }, [tasks])

    const taskCountByPriority = useMemo(() => {
      const counts: Record<Priority, number> = {
        urgent: 0,
        high: 0,
        medium: 0,
        low: 0,
        none: 0,
      }
      tasks.forEach((task) => {
        counts[task.priority]++
      })
      return counts
    }, [tasks])

    const taskCountByRepeat = useMemo(() => {
      let repeating = 0
      let oneTime = 0
      tasks.forEach((task) => {
        if (task.isRepeating) {
          repeating++
        } else {
          oneTime++
        }
      })
      return { repeating, oneTime }
    }, [tasks])

    const taskCountByTime = useMemo(() => {
      let withTime = 0
      let withoutTime = 0
      tasks.forEach((task) => {
        if (task.dueTime) {
          withTime++
        } else {
          withoutTime++
        }
      })
      return { withTime, withoutTime }
    }, [tasks])

    const taskCountByStatus = useMemo(() => {
      const counts: Record<string, number> = {}
      tasks.forEach((task) => {
        counts[task.statusId] = (counts[task.statusId] || 0) + 1
      })
      return counts
    }, [tasks])

    const handleOpenSaveDialog = (): void => {
      setIsSaveDialogOpen(true)
    }

    const handleSaveFilter = (name: string): void => {
      onSaveFilter(name, filters, sort)
      setIsSaveDialogOpen(false)
    }

    return (
      <div className={cn("border-b", className)}>
        {/* Main filter bar */}
        <div className="flex items-center gap-2 px-4 py-2">
          {/* Search */}
          <SearchInput
            ref={searchRef}
            value={filters.search}
            onChange={(search) => onUpdateFilters({ search })}
            placeholder="Search tasks..."
            expandOnFocus
          />

          {/* Divider */}
          <div className="h-6 w-px bg-border" />

          {/* Filter dropdowns */}
          <ProjectFilter
            projects={projects}
            selectedIds={filters.projectIds}
            onChange={(projectIds) => onUpdateFilters({ projectIds })}
            taskCountByProject={taskCountByProject}
          />

          <PriorityFilter
            selectedPriorities={filters.priorities}
            onChange={(priorities) => onUpdateFilters({ priorities })}
            taskCountByPriority={taskCountByPriority}
          />

          <DueDateFilter
            value={filters.dueDate}
            onChange={(dueDate) => onUpdateFilters({ dueDate })}
          />

          <MoreFiltersDropdown
            statuses={statuses}
            selectedStatusIds={filters.statusIds}
            onStatusChange={(statusIds) => onUpdateFilters({ statusIds })}
            showStatusFilter={showStatusFilter}
            repeatType={filters.repeatType}
            onRepeatTypeChange={(repeatType) => onUpdateFilters({ repeatType })}
            hasTime={filters.hasTime}
            onHasTimeChange={(hasTime) => onUpdateFilters({ hasTime })}
            taskCountByStatus={taskCountByStatus}
            taskCountByRepeat={taskCountByRepeat}
            taskCountByTime={taskCountByTime}
          />

          {/* Spacer */}
          <div className="flex-1" />

          {/* Saved filters */}
          <SavedFiltersDropdown
            savedFilters={savedFilters}
            onApply={onApplySavedFilter}
            onDelete={onDeleteSavedFilter}
          />

          {/* Sort */}
          <SortDropdown sort={sort} onChange={onUpdateSort} />

          {/* Select mode toggle */}
          {onToggleSelectionMode && (
            <>
              <div className="h-6 w-px bg-border" />
              <button
                type="button"
                onClick={onToggleSelectionMode}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                  "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isSelectionMode
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "text-muted-foreground hover:text-foreground"
                )}
                aria-label={isSelectionMode ? "Exit selection mode" : "Enter selection mode"}
                aria-pressed={isSelectionMode}
              >
                <CheckSquare className="size-4" />
                <span className="hidden sm:inline">Select</span>
              </button>
            </>
          )}
        </div>

        {/* Active filter chips */}
        {isActive && (
          <ActiveFiltersBar
            filters={filters}
            projects={projects}
            onUpdateFilters={onUpdateFilters}
            onClearAll={onClearFilters}
            onSaveFilter={handleOpenSaveDialog}
          />
        )}

        {/* Save filter dialog */}
        <SaveFilterDialog
          isOpen={isSaveDialogOpen}
          onClose={() => setIsSaveDialogOpen(false)}
          onSave={handleSaveFilter}
          filters={filters}
          sort={sort}
          projects={projects}
        />
      </div>
    )
  }
)

FilterBar.displayName = "FilterBar"

export default FilterBar
