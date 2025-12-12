import { useState, useRef, useMemo, forwardRef, useImperativeHandle } from "react"
import { CheckSquare, CircleCheck, SlidersHorizontal } from "lucide-react"

import { SearchInput } from "./search-input"
import { ProjectFilter } from "./project-filter"
import { PriorityFilter } from "./priority-filter"
import { DueDateFilter } from "./due-date-filter"
import { MoreFiltersDropdown } from "./more-filters-dropdown"
import { SortDropdown } from "./sort-dropdown"
import { ActiveFiltersBar } from "./active-filters-bar"
import { SavedFiltersDropdown } from "./saved-filters-dropdown"
import { SaveFilterDialog } from "./save-filter-dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type {
  TaskFilters,
  TaskSort,
  SavedFilter,
  Project,
  Status,
} from "@/data/tasks-data"
import { hasActiveFilters, countActiveFilters } from "@/lib/task-utils"
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
  /** Hide project filter UI (e.g. in Projects tab) */
  hideProjectFilter?: boolean
  /** Whether selection mode is active */
  isSelectionMode?: boolean
  /** Toggle selection mode on/off */
  onToggleSelectionMode?: () => void
  /** Whether to show the "Show Completed" toggle */
  showCompletionToggle?: boolean
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
      hideProjectFilter = false,
      isSelectionMode = false,
      onToggleSelectionMode,
      showCompletionToggle = false,
      className,
    },
    ref
  ) => {
    const searchRef = useRef<HTMLInputElement>(null)
    const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false)
    const [showFiltersPanel, setShowFiltersPanel] = useState(false)

    // Expose focusSearch method to parent
    useImperativeHandle(ref, () => ({
      focusSearch: () => {
        searchRef.current?.focus()
      },
    }))

    const isActive = hasActiveFilters(filters)
    const activeFilterCount = useMemo(() => countActiveFilters(filters), [filters])

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
        {/* Main compact bar with inline expandable filters */}
        <div className="flex items-center gap-2 px-4 py-2">
          {/* Left group grows, right group stays fixed */}
          <div className="flex items-center gap-2 min-w-0 flex-1">
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

            {/* Filters toggle */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowFiltersPanel((prev) => !prev)}
              className={cn(
                "h-9 gap-2 shrink-0",
                activeFilterCount > 0 && "border-primary bg-primary/5"
              )}
              aria-label="Toggle filters panel"
              aria-expanded={showFiltersPanel}
            >
              <SlidersHorizontal className="size-4 opacity-70" />
              <span>Filters</span>
              {activeFilterCount > 0 && (
                <span className="bg-primary text-primary-foreground text-xs px-1.5 py-0.5 rounded-full min-w-5 text-center">
                  {activeFilterCount}
                </span>
              )}
            </Button>

            {/* Inline expanded filters (uses remaining space, no wrap) */}
            {showFiltersPanel && (
              <div className="flex items-center gap-2 min-w-0 flex-1 overflow-x-auto overflow-y-hidden scrollbar-none h-9">
                {!hideProjectFilter && (
                  <ProjectFilter
                    projects={projects}
                    selectedIds={filters.projectIds}
                    onChange={(projectIds) => onUpdateFilters({ projectIds })}
                    taskCountByProject={taskCountByProject}
                    className="shrink-0"
                  />
                )}

                <PriorityFilter
                  selectedPriorities={filters.priorities}
                  onChange={(priorities) => onUpdateFilters({ priorities })}
                  taskCountByPriority={taskCountByPriority}
                  className="shrink-0"
                />

                <DueDateFilter
                  value={filters.dueDate}
                  onChange={(dueDate) => onUpdateFilters({ dueDate })}
                  className="shrink-0"
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
                  className="shrink-0"
                />

                <SavedFiltersDropdown
                  savedFilters={savedFilters}
                  onApply={onApplySavedFilter}
                  onDelete={onDeleteSavedFilter}
                />

                {showCompletionToggle && (
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateFilters({
                        completion: filters.completion === "all" ? "active" : "all",
                      })
                    }
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors shrink-0",
                      "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      filters.completion === "all"
                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                    aria-label={
                      filters.completion === "all"
                        ? "Hide completed tasks"
                        : "Show completed tasks"
                    }
                    aria-pressed={filters.completion === "all"}
                  >
                    <CircleCheck className="size-4" />
                    <span className="hidden sm:inline">Completed</span>
                  </button>
                )}

                {isActive && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onClearFilters}
                    className="h-9 text-xs text-muted-foreground hover:text-foreground shrink-0"
                  >
                    Clear
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Right group */}
          <div className="flex items-center gap-2 shrink-0">
            <SortDropdown sort={sort} onChange={onUpdateSort} />

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
