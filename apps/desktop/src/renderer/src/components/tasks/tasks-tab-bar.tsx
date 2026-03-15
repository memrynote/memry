import { useCallback, useRef, useState } from 'react'
import { Settings, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Project, SavedFilter } from '@/data/tasks-data'

export type TasksInternalTab = 'today' | 'all' | 'done'

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
    done: number
  }
  projects?: Project[]
  selectedProjectId?: string | null
  onProjectChange?: (projectId: string | null) => void
  onProjectEdit?: (project: Project) => void
  savedFilters?: SavedFilter[]
  activeSavedFilterId?: string | null
  onApplySavedFilter?: (filter: SavedFilter) => void
  onDeleteSavedFilter?: (filterId: string) => void
  className?: string
}

const TABS: TabConfig[] = [
  { id: 'today', label: 'Today' },
  { id: 'all', label: 'All' },
  { id: 'done', label: 'Done' }
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
  onDeleteSavedFilter,
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
        'flex items-center shrink-0 gap-2.5 [font-synthesis:none] text-[12px] leading-4 antialiased',
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
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                index > 0 && 'border-l border-border',
                isActive
                  ? 'bg-foreground text-background font-medium'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-active/50'
              )}
            >
              <span className="text-[12px] leading-4">{tab.label}</span>
              {count > 0 && (
                <span
                  className={cn(
                    'text-[9px] font-[family-name:var(--font-mono)] leading-3',
                    isActive ? 'text-background/45' : 'text-text-tertiary'
                  )}
                >
                  {count}
                </span>
              )}
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
                  ? 'saved-filter-active bg-amber-500/15 text-amber-700 dark:text-amber-400 font-medium'
                  : 'text-text-tertiary hover:text-text-primary hover:bg-surface-active/50'
              )}
            >
              <button
                type="button"
                aria-label={sf.name}
                onClick={() => onApplySavedFilter?.(sf)}
                className="flex items-baseline py-1 pl-2.5 pr-1 gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <span className="text-[12px] leading-4">{sf.name}</span>
              </button>
              <button
                type="button"
                aria-label={`Remove ${sf.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onDeleteSavedFilter?.(sf.id)
                }}
                className="p-0.5 mr-0.5 rounded-sm opacity-0 group-hover/pill:opacity-100 focus:opacity-100 transition-opacity hover:text-[#E54D2E] focus-visible:outline-none"
              >
                <X className="size-3" />
              </button>
            </div>
          )
        })}
      </div>

      {/* All Projects Dropdown */}
      {onProjectChange && (
        <Popover open={isProjectDropdownOpen} onOpenChange={setIsProjectDropdownOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center shrink-0 whitespace-nowrap rounded-[5px] py-1 px-2.5 gap-[5px] border border-border text-text-secondary hover:text-text-primary hover:bg-surface-active/50 transition-colors"
            >
              <span
                className={cn(
                  'rounded-[3px] shrink-0 size-[5px]',
                  !selectedProject && 'bg-foreground'
                )}
                style={selectedProject ? { backgroundColor: selectedProject.color } : undefined}
              />
              <span className="text-[12px] leading-4">
                {selectedProject?.name ?? 'All projects'}
              </span>
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                className="text-text-tertiary"
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
          <PopoverContent className="w-[200px] p-1" align="start">
            <button
              type="button"
              onClick={() => {
                onProjectChange(null)
                setIsProjectDropdownOpen(false)
              }}
              className={cn(
                'w-full flex items-center gap-2 rounded-sm py-2 px-3 text-sm transition-colors',
                'hover:bg-accent focus:outline-none',
                !selectedProjectId && 'bg-accent font-medium'
              )}
            >
              <span className="rounded-full shrink-0 size-1.5 bg-foreground" />
              <span className="text-[13px] text-text-secondary">All projects</span>
            </button>
            {activeProjects.map((p) => (
              <div key={p.id} className="group/project-item flex items-center">
                <button
                  type="button"
                  onClick={() => {
                    onProjectChange(p.id)
                    setIsProjectDropdownOpen(false)
                  }}
                  className={cn(
                    'flex-1 flex items-center gap-2 rounded-sm py-2 px-3 text-sm transition-colors',
                    'hover:bg-accent focus:outline-none',
                    p.id === selectedProjectId && 'bg-accent font-medium'
                  )}
                >
                  <span
                    className="rounded-full shrink-0 size-1.5"
                    style={{ backgroundColor: p.color }}
                  />
                  <span className="text-[13px] text-text-secondary">{p.name}</span>
                </button>
                {onProjectEdit && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onProjectEdit(p)
                      setIsProjectDropdownOpen(false)
                    }}
                    className="shrink-0 p-1.5 mr-1 rounded-sm opacity-0 group-hover/project-item:opacity-100 transition-opacity hover:bg-accent"
                    aria-label={`Edit ${p.name}`}
                  >
                    <Settings className="size-3 text-text-tertiary" />
                  </button>
                )}
              </div>
            ))}
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
