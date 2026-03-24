import { useCallback, useMemo, useRef, useState } from 'react'
import { Settings, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { FilterSearchHeader } from '@/components/ui/filter-search-header'
import { CheckMark } from '@/components/ui/check-mark'
import type { Project, SavedFilter } from '@/data/tasks-data'

export type TasksInternalTab = 'today' | 'all'

interface TabConfig {
  id: TasksInternalTab
  label: string
}

interface TasksTabBarProps {
  activeTab: TasksInternalTab
  onTabChange: (tab: TasksInternalTab) => void
  counts: {
    today: number
    all: number
  }
  projects?: Project[]
  selectedProjectId?: string | null
  onProjectChange?: (projectId: string | null) => void
  onProjectEdit?: (project: Project) => void
  savedFilters?: SavedFilter[]
  activeSavedFilterId?: string | null
  onApplySavedFilter?: (filter: SavedFilter) => void
  onUnstarSavedFilter?: (filterId: string) => void
  className?: string
}

const TABS: TabConfig[] = [
  { id: 'today', label: 'Today' },
  { id: 'all', label: 'All' }
]

export const TasksTabBar = ({
  activeTab,
  onTabChange,
  counts,
  projects = [],
  selectedProjectId,
  onProjectChange,
  onProjectEdit,
  savedFilters = [],
  activeSavedFilterId,
  onApplySavedFilter,
  onUnstarSavedFilter,
  className
}: TasksTabBarProps): React.JSX.Element => {
  const tabRefs = useRef<Map<TasksInternalTab, HTMLButtonElement>>(new Map())
  const [isProjectDropdownOpen, setIsProjectDropdownOpen] = useState(false)

  const focusTab = useCallback((tabId: TasksInternalTab) => {
    tabRefs.current.get(tabId)?.focus()
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, currentIndex: number) => {
      let nextIndex: number | null = null
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault()
          nextIndex = currentIndex > 0 ? currentIndex - 1 : TABS.length - 1
          break
        case 'ArrowRight':
          e.preventDefault()
          nextIndex = currentIndex < TABS.length - 1 ? currentIndex + 1 : 0
          break
        case 'Home':
          e.preventDefault()
          nextIndex = 0
          break
        case 'End':
          e.preventDefault()
          nextIndex = TABS.length - 1
          break
      }
      if (nextIndex !== null) {
        const nextTab = TABS[nextIndex]
        focusTab(nextTab.id)
        onTabChange(nextTab.id)
      }
    },
    [focusTab, onTabChange]
  )

  const setTabRef = useCallback(
    (tabId: TasksInternalTab) => (el: HTMLButtonElement | null) => {
      if (el) {
        tabRefs.current.set(tabId, el)
      } else {
        tabRefs.current.delete(tabId)
      }
    },
    []
  )

  const activeProjects = projects.filter((p) => !p.isArchived)
  const selectedProject = selectedProjectId
    ? activeProjects.find((p) => p.id === selectedProjectId)
    : null

  return (
    <div
      className={cn(
        'flex items-center shrink-0 gap-2.5 [font-synthesis:none] text-[13px] leading-4 antialiased',
        className
      )}
    >
      {/* Segmented Tab Control */}
      <div
        className="flex items-center shrink-0 rounded-[5px] overflow-clip border border-border"
        role="tablist"
        aria-label="Task views"
      >
        {TABS.map((tab, index) => {
          const isActive = activeTab === tab.id && !activeSavedFilterId
          const count = counts[tab.id]

          return (
            <button
              key={tab.id}
              ref={setTabRef(tab.id)}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`tabpanel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onTabChange(tab.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={cn(
                'flex items-center py-1 px-2.5 gap-1 transition-colors',
                'focus-visible:outline-none',
                index > 0 && 'border-l border-border',
                isActive
                  ? 'bg-foreground text-background font-medium'
                  : 'text-muted-foreground hover:text-foreground/90 hover:bg-surface-active/50'
              )}
            >
              <span className="text-[13px] leading-4">{tab.label}</span>
              <span
                className={cn(
                  'text-[9px] font-[family-name:var(--font-mono)] leading-3 tabular-nums min-w-[2ch] text-center',
                  count === 0 && 'invisible',
                  isActive ? 'text-background/45' : 'text-muted-foreground/60'
                )}
              >
                {count}
              </span>
            </button>
          )
        })}
        {/* Saved Filter Pills — inside segmented control */}
        {savedFilters.map((sf) => {
          const isActive = activeSavedFilterId === sf.id
          return (
            <div
              key={sf.id}
              data-testid="saved-filter-pill"
              className={cn(
                'group/pill flex items-center whitespace-nowrap border-l border-border transition-colors',
                isActive
                  ? 'saved-filter-active bg-task-star/15 text-task-star font-medium'
                  : 'text-muted-foreground/60 hover:text-foreground/90 hover:bg-surface-active/50'
              )}
            >
              <button
                type="button"
                aria-label={sf.name}
                onClick={() => onApplySavedFilter?.(sf)}
                className="flex items-baseline py-1 pl-2.5 pr-1 gap-1 focus-visible:outline-none"
              >
                <span className="text-[13px] leading-4">{sf.name}</span>
              </button>
              <button
                type="button"
                aria-label={`Unstar ${sf.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onUnstarSavedFilter?.(sf.id)
                }}
                className="p-0.5 mr-0.5 rounded-sm opacity-0 group-hover/pill:opacity-100 focus:opacity-100 transition-opacity hover:text-text-tertiary focus-visible:outline-none"
              >
                <X className="size-3" />
              </button>
            </div>
          )
        })}
      </div>

      {/* All Projects Dropdown */}
      {onProjectChange && (
        <ProjectDropdown
          projects={activeProjects}
          selectedProjectId={selectedProjectId ?? null}
          onProjectChange={(id) => {
            onProjectChange(id)
            setIsProjectDropdownOpen(false)
          }}
          onProjectEdit={onProjectEdit}
          open={isProjectDropdownOpen}
          onOpenChange={setIsProjectDropdownOpen}
          selectedProject={selectedProject ?? null}
        />
      )}
    </div>
  )
}

interface ProjectDropdownProps {
  projects: Project[]
  selectedProjectId: string | null
  onProjectChange: (projectId: string | null) => void
  onProjectEdit?: (project: Project) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedProject: Project | null
}

function ProjectDropdown({
  projects,
  selectedProjectId,
  onProjectChange,
  onProjectEdit,
  open,
  onOpenChange,
  selectedProject
}: ProjectDropdownProps): React.JSX.Element {
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    if (!search) return projects
    const q = search.toLowerCase()
    return projects.filter((p) => p.name.toLowerCase().includes(q))
  }, [projects, search])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) setSearch('')
      onOpenChange(next)
    },
    [onOpenChange]
  )

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center shrink-0 whitespace-nowrap rounded-[5px] py-1 px-2.5 gap-[5px] border border-border text-muted-foreground hover:text-foreground/90 hover:bg-surface-active/50 transition-colors"
        >
          <span
            className={cn(
              'rounded-[3px] shrink-0 size-2.5',
              !selectedProject && 'border-[1.2px] border-solid border-border'
            )}
            style={selectedProject ? { backgroundColor: selectedProject.color } : undefined}
          />
          <span className="text-[13px] leading-4">{selectedProject?.name ?? 'All projects'}</span>
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            className="text-muted-foreground/60"
          >
            <path
              d="M2.5 3.75l2.5 2.5 2.5-2.5"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[200px] p-0 rounded-md overflow-clip bg-popover border-border shadow-[var(--shadow-card-hover)]"
        align="start"
        sideOffset={8}
      >
        <div className="flex flex-col text-[13px] leading-4 [font-synthesis:none] antialiased">
          <FilterSearchHeader
            value={search}
            onChange={setSearch}
            placeholder="Search projects..."
          />
          <div className="flex flex-col p-1 max-h-64 overflow-y-auto">
            <button
              type="button"
              onClick={() => onProjectChange(null)}
              className={cn(
                'flex items-center rounded-[5px] py-1.5 px-2 gap-2 transition-colors',
                !selectedProjectId ? 'bg-accent' : 'hover:bg-accent'
              )}
            >
              <div className="shrink-0 rounded-[3px] border-[1.2px] border-solid border-border size-2.5" />
              <span className="text-[13px] text-muted-foreground/60 leading-4">All projects</span>
              {!selectedProjectId && <CheckMark className="ml-auto text-primary" />}
            </button>
            {filtered.map((p) => {
              const isSelected = p.id === selectedProjectId
              return (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onProjectChange(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onProjectChange(p.id)
                    }
                  }}
                  className={cn(
                    'group/project-item flex items-center rounded-[5px] py-1.5 px-2 gap-2 cursor-pointer transition-colors',
                    isSelected ? 'bg-accent' : 'hover:bg-accent'
                  )}
                >
                  <div
                    className="shrink-0 rounded-[3px] size-2.5"
                    style={{ backgroundColor: p.color }}
                  />
                  <span
                    className={cn(
                      'text-[13px] leading-4',
                      isSelected ? 'text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {p.name}
                  </span>
                  {(isSelected || onProjectEdit) && (
                    <div className="ml-auto shrink-0 size-3 relative">
                      {isSelected && (
                        <span
                          className={cn(
                            'absolute inset-0 flex items-center justify-center transition-opacity',
                            onProjectEdit && 'group-hover/project-item:opacity-0'
                          )}
                        >
                          <CheckMark className="text-primary" />
                        </span>
                      )}
                      {onProjectEdit && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            onProjectEdit(p)
                            handleOpenChange(false)
                          }}
                          className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/project-item:opacity-100 transition-opacity"
                          aria-label={`Edit ${p.name}`}
                        >
                          <Settings className="size-3 text-text-tertiary" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
