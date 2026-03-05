import { useCallback, useRef } from 'react'
import { List, Star, FolderKanban, Plus, Settings, Columns3, Calendar } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ViewMode } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

export type TasksInternalTab = 'all' | 'today' | 'projects'

interface TabConfig {
  id: TasksInternalTab
  label: string
  icon: React.ComponentType<{ className?: string }>
}

interface ViewModeConfig {
  id: ViewMode
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const viewModeButtons: ViewModeConfig[] = [
  { id: 'list', label: 'List', icon: List },
  { id: 'kanban', label: 'Kanban', icon: Columns3 },
  { id: 'calendar', label: 'Calendar', icon: Calendar }
]

interface TasksTabBarProps {
  activeTab: TasksInternalTab
  onTabChange: (tab: TasksInternalTab) => void
  onAddTask?: () => void
  onProjectSettings?: () => void
  showProjectSettings?: boolean
  counts: {
    all: number
    today: number
    projects: number
  }
  activeView?: ViewMode
  availableViews?: ViewMode[]
  onViewChange?: (view: ViewMode) => void
  className?: string
}

// ============================================================================
// TAB CONFIGURATION
// ============================================================================

const tabs: TabConfig[] = [
  { id: 'all', label: 'All', icon: List },
  { id: 'today', label: 'Today', icon: Star },
  { id: 'projects', label: 'Projects', icon: FolderKanban }
]

// ============================================================================
// TASKS TAB BAR COMPONENT
// ============================================================================

export const TasksTabBar = ({
  activeTab,
  onTabChange,
  onAddTask,
  onProjectSettings,
  showProjectSettings,
  counts,
  activeView = 'list',
  availableViews,
  onViewChange,
  className
}: TasksTabBarProps): React.JSX.Element => {
  const tabRefs = useRef<Map<TasksInternalTab, HTMLButtonElement>>(new Map())

  // Focus management for keyboard navigation
  const focusTab = useCallback((tabId: TasksInternalTab) => {
    const button = tabRefs.current.get(tabId)
    button?.focus()
  }, [])

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, currentIndex: number) => {
      let nextIndex: number | null = null

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault()
          nextIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1
          break
        case 'ArrowRight':
          e.preventDefault()
          nextIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0
          break
        case 'Home':
          e.preventDefault()
          nextIndex = 0
          break
        case 'End':
          e.preventDefault()
          nextIndex = tabs.length - 1
          break
      }

      if (nextIndex !== null) {
        const nextTab = tabs[nextIndex]
        focusTab(nextTab.id)
        onTabChange(nextTab.id)
      }
    },
    [focusTab, onTabChange]
  )

  // Set ref for each tab button
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

  return (
    <div className={cn('border-b border-border', className)} role="tablist" aria-label="Task views">
      <div className="flex items-center gap-1 px-6">
        {tabs.map((tab, index) => {
          const isActive = activeTab === tab.id
          const count = counts[tab.id]
          const Icon = tab.icon

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
                'relative flex items-center gap-2 px-3 py-2.5 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                'rounded-t-md',
                isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              <span>{tab.label}</span>
              {count > 0 && (
                <span
                  className={cn(
                    'inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-medium min-w-[20px]',
                    isActive ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                  )}
                >
                  {count > 99 ? '99+' : count}
                </span>
              )}
              {/* Active indicator */}
              {isActive && (
                <span
                  className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary"
                  aria-hidden="true"
                />
              )}
            </button>
          )
        })}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Actions side */}
        <div className="flex items-center gap-2 py-2">
          {/* View Mode Toggle */}
          {availableViews && availableViews.length > 1 && onViewChange && (
            <div
              className="flex items-center rounded-md border border-border bg-muted/40 p-0.5"
              role="radiogroup"
              aria-label="View mode"
            >
              {viewModeButtons
                .filter((vm) => availableViews.includes(vm.id))
                .map((vm) => {
                  const isActive = activeView === vm.id
                  const Icon = vm.icon
                  return (
                    <Tooltip key={vm.id}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={isActive}
                          aria-label={`${vm.label} view`}
                          onClick={() => onViewChange(vm.id)}
                          className={cn(
                            'rounded-sm p-1.5 transition-all duration-150',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            isActive
                              ? 'bg-background text-foreground shadow-sm'
                              : 'text-muted-foreground hover:text-foreground'
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

          {showProjectSettings && onProjectSettings && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onProjectSettings}
                  className={cn(
                    'rounded-md p-1.5 text-muted-foreground transition-all duration-200',
                    'hover:bg-accent hover:text-foreground',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                  )}
                  aria-label="Project settings"
                >
                  <Settings className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Project settings</TooltipContent>
            </Tooltip>
          )}

          {onAddTask && (
            <Button
              onClick={onAddTask}
              variant="default"
              size="sm"
              className="h-8 gap-1.5 px-3 shadow-sm transition-all duration-200"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              <span>Add Task</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
