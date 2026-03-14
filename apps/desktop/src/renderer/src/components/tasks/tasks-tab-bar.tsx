import { useCallback, useRef, useState } from 'react'
import { List, Columns3, Calendar, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { ViewMode, Project } from '@/data/tasks-data'

export type TasksInternalTab = 'today' | 'thisWeek' | 'all' | 'done'

interface TabConfig {
  id: TasksInternalTab
  label: string
}

interface ViewModeConfig {
  id: ViewMode
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const VIEW_MODE_BUTTONS: ViewModeConfig[] = [
  { id: 'list', label: 'List', icon: List },
  { id: 'kanban', label: 'Kanban', icon: Columns3 },
  { id: 'calendar', label: 'Calendar', icon: Calendar }
]

interface TasksTabBarProps {
  activeTab: TasksInternalTab
  onTabChange: (tab: TasksInternalTab) => void
  counts: {
    today: number
    thisWeek: number
    all: number
    done: number
  }
  activeView?: ViewMode
  availableViews?: ViewMode[]
  onViewChange?: (view: ViewMode) => void
  projects?: Project[]
  selectedProjectId?: string | null
  onProjectChange?: (projectId: string | null) => void
  className?: string
}

const TABS: TabConfig[] = [
  { id: 'today', label: 'Today' },
  { id: 'thisWeek', label: 'This Week' },
  { id: 'all', label: 'All' },
  { id: 'done', label: 'Done' }
]

export const TasksTabBar = ({
  activeTab,
  onTabChange,
  counts,
  activeView = 'list',
  availableViews,
  onViewChange,
  projects = [],
  selectedProjectId,
  onProjectChange,
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
    <div className={cn('flex items-center py-[18px] gap-3 border-b border-border', className)}>
      {/* Segmented Tab Control */}
      <div
        className="flex items-center rounded-sm overflow-hidden border border-border"
        role="tablist"
        aria-label="Task views"
      >
        {TABS.map((tab, index) => {
          const isActive = activeTab === tab.id
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
                'flex items-center py-[7px] px-4 gap-1.5 transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                index > 0 && 'border-l border-border',
                isActive
                  ? 'bg-foreground text-background font-medium'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-active/50'
              )}
            >
              <span className="text-[13px] leading-4">{tab.label}</span>
              {count > 0 && (
                <span
                  className={cn(
                    isActive
                      ? 'rounded-sm px-1.5 bg-white/15 text-[16px] font-sans leading-5 text-background'
                      : 'text-[10px] font-[family-name:var(--font-mono)] leading-3 text-text-tertiary'
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* All Projects Dropdown */}
      {onProjectChange && (
        <Popover open={isProjectDropdownOpen} onOpenChange={setIsProjectDropdownOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center rounded-sm py-[7px] px-3.5 gap-1.5 border border-border text-text-secondary hover:text-text-primary hover:bg-surface-active/50 transition-colors"
            >
              <span
                className="rounded-full shrink-0 size-1.5"
                style={{
                  backgroundColor: selectedProject?.color ?? '#1A1A1A'
                }}
              />
              <span className="text-[13px] leading-4">
                {selectedProject?.name ?? 'All projects'}
              </span>
              <ChevronDown className="size-3 text-text-tertiary" />
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
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onProjectChange(p.id)
                  setIsProjectDropdownOpen(false)
                }}
                className={cn(
                  'w-full flex items-center gap-2 rounded-sm py-2 px-3 text-sm transition-colors',
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
            ))}
          </PopoverContent>
        </Popover>
      )}

      {/* View Mode Switcher (pushed right) */}
      {availableViews && availableViews.length > 1 && onViewChange && (
        <div
          className="flex items-center ml-auto rounded-sm p-[3px] gap-0.5 bg-surface"
          role="radiogroup"
          aria-label="View mode"
        >
          {VIEW_MODE_BUTTONS.filter((vm) => availableViews.includes(vm.id)).map((vm) => {
            const isVmActive = activeView === vm.id
            const Icon = vm.icon
            return (
              <Tooltip key={vm.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isVmActive}
                    aria-label={`${vm.label} view`}
                    onClick={() => onViewChange(vm.id)}
                    className={cn(
                      'rounded-sm py-[5px] px-2 transition-all duration-150',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      isVmActive
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-text-tertiary hover:text-text-secondary'
                    )}
                  >
                    <Icon className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{vm.label}</TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      )}
    </div>
  )
}
