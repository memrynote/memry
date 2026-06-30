import { useCallback, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Settings, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { ProjectPicker } from '@/components/tasks/project-picker'
import type { Project, SavedFilter } from '@/data/tasks-data'

export type TasksInternalTab = 'today' | 'all'

interface TabConfig {
  id: TasksInternalTab
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

const TABS: TabConfig[] = [{ id: 'today' }, { id: 'all' }]

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
  const { t } = useT('tasks')
  const tabRefs = useRef<Map<TasksInternalTab, HTMLButtonElement> | null>(null)
  if (tabRefs.current === null) {
    tabRefs.current = new Map()
  }

  const focusTab = useCallback((tabId: TasksInternalTab) => {
    tabRefs.current?.get(tabId)?.focus()
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
        tabRefs.current?.set(tabId, el)
      } else {
        tabRefs.current?.delete(tabId)
      }
    },
    []
  )

  const activeProjects = projects.filter((p) => !p.isArchived)
  const getTabLabel = (tabId: TasksInternalTab): string =>
    tabId === 'today' ? t('page.tabs.today') : t('page.tabs.all')

  return (
    <div
      className={cn(
        'flex items-center shrink-0 gap-2.5 [font-synthesis:none] text-[12px] leading-4',
        className
      )}
    >
      {/* Segmented Tab Control */}
      <div
        className="flex items-center shrink-0 rounded-[5px] overflow-clip border border-border"
        role="tablist"
        aria-label={t('page.tabs.label')}
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
                index > 0 && 'border-s border-border',
                isActive
                  ? 'bg-foreground text-background font-medium'
                  : 'text-muted-foreground hover:text-foreground/90 hover:bg-surface-active/50'
              )}
            >
              <span className="text-[12px] leading-4">{getTabLabel(tab.id)}</span>
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
                'group/pill flex items-center whitespace-nowrap border-s border-border transition-colors',
                isActive
                  ? 'saved-filter-active bg-task-star/15 text-task-star font-medium'
                  : 'text-muted-foreground/60 hover:text-foreground/90 hover:bg-surface-active/50'
              )}
            >
              <button
                type="button"
                aria-label={sf.name}
                onClick={() => onApplySavedFilter?.(sf)}
                className="flex items-baseline py-1 ps-2.5 pe-1 gap-1 focus-visible:outline-none"
              >
                <span className="text-[12px] leading-4">{sf.name}</span>
              </button>
              <button
                type="button"
                aria-label={t('page.projectScope.unstarSavedFilter', { name: sf.name })}
                onClick={(e) => {
                  e.stopPropagation()
                  onUnstarSavedFilter?.(sf.id)
                }}
                className="p-0.5 me-0.5 rounded-sm opacity-0 group-hover/pill:opacity-100 focus:opacity-100 transition-opacity hover:text-text-tertiary focus-visible:outline-none"
              >
                <X className="size-3" />
              </button>
            </div>
          )
        })}
      </div>

      {/* Project scope dropdown — shared ProjectPicker (search + All projects + create) */}
      {onProjectChange && (
        <ProjectPicker
          value={selectedProjectId ?? null}
          onChange={onProjectChange}
          projects={activeProjects}
          includeAllOption
          searchable
          contentWidth={240}
          className="h-auto rounded-[5px] px-2.5 py-1 text-[12px] leading-4 font-medium shadow-none"
          renderItemActions={
            onProjectEdit
              ? (project) => (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onProjectEdit(project)
                    }}
                    className="flex items-center justify-center rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
                    aria-label={t('page.projectScope.editProject', { name: project.name })}
                  >
                    <Settings className="size-3 text-text-tertiary" />
                  </button>
                )
              : undefined
          }
        />
      )}
    </div>
  )
}
