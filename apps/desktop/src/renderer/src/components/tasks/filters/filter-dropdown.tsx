import { useState, useCallback, useMemo } from 'react'

import { ChevronRight } from '@/lib/icons'
import { Picker } from '@/components/ui/picker'
import type { TaskFilters, Project, Status, DueDateFilterType } from '@/data/tasks-data'
import type { Priority, Task } from '@/data/sample-tasks'
import type { SavedFilter } from '@/data/tasks-data'

import { PriorityPanel } from './filter-panels/priority-panel'
import { StatusPanel } from './filter-panels/status-panel'
import { StatusProjectPickerPanel } from './filter-panels/status-project-picker-panel'
import { DueDatePanel } from './filter-panels/due-date-panel'
import { ProjectPanel } from './filter-panels/project-panel'
import { SavedFiltersSection } from './saved-filters-section'

interface FilterDropdownProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  filters: TaskFilters
  onUpdateFilters: (updates: Partial<TaskFilters>) => void
  onClearFilters: () => void
  tasks: Task[]
  projects: Project[]
  savedFilters: SavedFilter[]
  activeSavedFilterId?: string | null
  hasActiveFilters: boolean
  onDeleteSavedFilter: (filterId: string) => void
  onApplySavedFilter: (filter: SavedFilter) => void
  onSaveFilter: (name: string) => void
  onToggleStarFilter: (filterId: string) => void
  statuses?: Status[]
  children: React.ReactNode
}

type ActivePanel = null | 'priority' | 'status' | 'dueDate' | 'project' | 'status-project-picker'

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  priority: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-muted-foreground">
      <rect x="1.5" y="8" width="2.5" height="4.5" rx="0.5" fill="currentColor" />
      <rect x="5.5" y="5" width="2.5" height="7.5" rx="0.5" fill="currentColor" />
      <rect x="9.5" y="2" width="2.5" height="10.5" rx="0.5" fill="currentColor" />
    </svg>
  ),
  status: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-muted-foreground">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  ),
  dueDate: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-muted-foreground">
      <rect
        x="2"
        y="2.5"
        width="10"
        height="9.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <path d="M2 5.5h10" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  ),
  project: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-muted-foreground">
      <path
        d="M2 4.5V11a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 12 11V5.5A1.5 1.5 0 0 0 10.5 4H7L5.5 2H3.5A1.5 1.5 0 0 0 2 3.5v1z"
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  )
}

export const FilterDropdown = ({
  open,
  onOpenChange,
  filters,
  onUpdateFilters,
  onClearFilters: _onClearFilters,
  tasks,
  projects,
  savedFilters,
  activeSavedFilterId,
  hasActiveFilters,
  onDeleteSavedFilter,
  onApplySavedFilter,
  onSaveFilter,
  onToggleStarFilter,
  statuses: statusesProp = [],
  children
}: FilterDropdownProps): React.JSX.Element => {
  const [activePanel, setActivePanel] = useState<ActivePanel>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilterProjectId, setStatusFilterProjectId] = useState<string | null>(null)

  const statuses = useMemo(() => {
    if (statusesProp.length > 0) return statusesProp
    if (statusFilterProjectId) {
      const project = projects.find((p) => p.id === statusFilterProjectId)
      return project?.statuses ?? []
    }
    return []
  }, [statusesProp, statusFilterProjectId, projects])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setActivePanel(null)
        setSearchQuery('')
        setStatusFilterProjectId(null)
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange]
  )

  const navigateTo = useCallback((panel: ActivePanel) => {
    setActivePanel(panel)
    setSearchQuery('')
  }, [])

  const goBack = useCallback(() => {
    setActivePanel(null)
    setSearchQuery('')
  }, [])

  const togglePriority = useCallback(
    (p: Priority) => {
      const next = filters.priorities.includes(p)
        ? filters.priorities.filter((x) => x !== p)
        : [...filters.priorities, p]
      onUpdateFilters({ priorities: next })
    },
    [filters.priorities, onUpdateFilters]
  )

  const toggleStatus = useCallback(
    (statusId: string) => {
      const next = filters.statusIds.includes(statusId)
        ? filters.statusIds.filter((id) => id !== statusId)
        : [...filters.statusIds, statusId]
      onUpdateFilters({ statusIds: next })
    },
    [filters.statusIds, onUpdateFilters]
  )

  const selectDueDate = useCallback(
    (type: DueDateFilterType) => {
      onUpdateFilters({ dueDate: { type, customStart: null, customEnd: null } })
    },
    [onUpdateFilters]
  )

  const selectCalendarDate = useCallback(
    (day: number, year: number, month: number) => {
      const date = new Date(year, month, day)
      onUpdateFilters({ dueDate: { type: 'custom', customStart: date, customEnd: date } })
    },
    [onUpdateFilters]
  )

  const clearDueDate = useCallback(() => {
    onUpdateFilters({ dueDate: { type: 'any', customStart: null, customEnd: null } })
  }, [onUpdateFilters])

  const toggleProject = useCallback(
    (projectId: string) => {
      const next = filters.projectIds.includes(projectId)
        ? filters.projectIds.filter((id) => id !== projectId)
        : [...filters.projectIds, projectId]
      onUpdateFilters({ projectIds: next })
    },
    [filters.projectIds, onUpdateFilters]
  )

  const clearProjectFilter = useCallback(() => {
    onUpdateFilters({ projectIds: [] })
  }, [onUpdateFilters])

  const categories: { key: NonNullable<ActivePanel>; label: string }[] = [
    { key: 'priority', label: 'Priority' },
    { key: 'status', label: 'Status' },
    { key: 'dueDate', label: 'Due date' },
    { key: 'project', label: 'Project' }
  ]

  const filteredCategories = useMemo(() => {
    if (!searchQuery) return categories
    const q = searchQuery.toLowerCase()
    return categories.filter((c) => c.label.toLowerCase().includes(q))
  }, [searchQuery])

  return (
    <Picker open={open} onOpenChange={handleOpenChange} closeOnSelect={false}>
      <Picker.Trigger asChild>{children}</Picker.Trigger>
      <Picker.Content
        width={220}
        align="end"
        sideOffset={8}
        className="max-h-[calc(100vh-120px)] overflow-y-auto"
      >
        {activePanel === null && (
          <>
            <Picker.Search placeholder="Filter by..." />
            <Picker.List>
              {filteredCategories.map((cat) => (
                <button
                  key={cat.key}
                  type="button"
                  onClick={() => {
                    if (cat.key === 'status' && statusesProp.length === 0) {
                      navigateTo('status-project-picker')
                    } else {
                      navigateTo(cat.key)
                    }
                  }}
                  className="flex items-center rounded-[5px] py-1.5 px-2 gap-2 hover:bg-accent transition-colors"
                >
                  {CATEGORY_ICONS[cat.key]}
                  <span className="text-muted-foreground">{cat.label}</span>
                  <ChevronRight size={10} className="ml-auto text-muted-foreground/60" />
                </button>
              ))}
            </Picker.List>
            <SavedFiltersSection
              savedFilters={savedFilters}
              activeSavedFilterId={activeSavedFilterId}
              hasActiveFilters={hasActiveFilters}
              onApply={onApplySavedFilter}
              onDelete={onDeleteSavedFilter}
              onToggleStar={onToggleStarFilter}
              onSave={onSaveFilter}
            />
          </>
        )}

        {activePanel === 'priority' && (
          <PriorityPanel
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            selectedPriorities={filters.priorities}
            onTogglePriority={togglePriority}
            onClose={() => handleOpenChange(false)}
            onGoBack={goBack}
            tasks={tasks}
          />
        )}

        {activePanel === 'status-project-picker' && (
          <StatusProjectPickerPanel
            projects={projects}
            onSelectProject={(projectId) => {
              setStatusFilterProjectId(projectId)
              navigateTo('status')
            }}
            onGoBack={goBack}
          />
        )}

        {activePanel === 'status' && (
          <StatusPanel
            statuses={statuses}
            selectedStatusIds={filters.statusIds}
            onToggleStatus={toggleStatus}
            onGoBack={
              statusesProp.length === 0 ? () => navigateTo('status-project-picker') : goBack
            }
            tasks={tasks}
          />
        )}

        {activePanel === 'dueDate' && (
          <DueDatePanel
            dueDate={filters.dueDate}
            onSelectDueDate={selectDueDate}
            onSelectCalendarDate={selectCalendarDate}
            onClearDueDate={clearDueDate}
            onGoBack={goBack}
          />
        )}

        {activePanel === 'project' && (
          <ProjectPanel
            projects={projects}
            selectedProjectIds={filters.projectIds}
            onToggleProject={toggleProject}
            onClearProjectFilter={clearProjectFilter}
            onGoBack={goBack}
          />
        )}
      </Picker.Content>
    </Picker>
  )
}
