import { useT } from '@memry/i18n/renderer'
import { Settings, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Picker } from '@/components/ui/picker'
import { ProjectPicker } from '@/components/tasks/project-picker'
import type { TaskDueWindow } from '@/lib/task-utils'
import type { Project, SavedFilter } from '@/data/tasks-data'

/** The scope the task list is showing: every open task, or one due-date window. */
export type TasksInternalTab = 'all' | TaskDueWindow

/**
 * Counts per scope shown in the dropdown. `archived` is not a `TasksInternalTab`
 * — it is the archived filter scope — but it renders in the same list, so it
 * carries its count in the same record.
 */
export type TasksTabCounts = Record<TasksInternalTab | 'archived', number>

/** The scope dropdown value that means "archived tasks only", not a due window. */
export const ARCHIVED_SCOPE_VALUE = 'archived'

interface TasksTabBarProps {
  activeTab: TasksInternalTab
  onTabChange: (tab: TasksInternalTab) => void
  /** Archived scope is on: the list shows archived tasks instead of a due window. */
  isArchivedScope?: boolean
  onArchivedScopeChange?: (isArchived: boolean) => void
  counts: TasksTabCounts
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

const TABS: TasksInternalTab[] = ['all', 'today', 'tomorrow', 'next7']

export const TasksTabBar = ({
  activeTab,
  onTabChange,
  isArchivedScope = false,
  onArchivedScopeChange,
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

  const activeProjects = projects.filter((p) => !p.isArchived)
  const getTabLabel = (tab: TasksInternalTab): string => t(`page.tabs.${tab}`)

  const handleTabChange = (value: string): void => {
    if (value === ARCHIVED_SCOPE_VALUE) {
      onArchivedScopeChange?.(true)
      return
    }
    const next = TABS.find((tab) => tab === value)
    if (!next) return
    if (isArchivedScope) onArchivedScopeChange?.(false)
    if (next !== activeTab) onTabChange(next)
  }

  const scopeValue = isArchivedScope ? ARCHIVED_SCOPE_VALUE : activeTab
  const scopeLabel = isArchivedScope ? t('page.tabs.archived') : getTabLabel(activeTab)
  const archivedCount = counts.archived
  const scopeCount = isArchivedScope ? archivedCount : counts[activeTab]

  return (
    <div
      className={cn(
        'flex items-center shrink-0 gap-2.5 [font-synthesis:none] text-[12px] leading-4',
        className
      )}
    >
      {/* Due-window scope dropdown */}
      <Picker value={activeSavedFilterId ? null : scopeValue} onValueChange={handleTabChange}>
        <Picker.Trigger
          variant="button"
          chevron
          aria-label={t('page.tabs.label')}
          className="h-auto rounded-[5px] px-2.5 py-1 text-[12px] leading-4 font-medium shadow-none"
        >
          <span className="flex items-baseline gap-1">
            <span>{scopeLabel}</span>
            <span
              className={cn(
                'text-[9px] font-[family-name:var(--font-mono)] leading-3 tabular-nums',
                'text-muted-foreground/60',
                scopeCount === 0 && 'invisible'
              )}
            >
              {scopeCount}
            </span>
          </span>
        </Picker.Trigger>
        <Picker.Content width={180} align="start">
          <Picker.List>
            {TABS.map((tab) => (
              <Picker.Item
                key={tab}
                value={tab}
                label={getTabLabel(tab)}
                indicator="check"
                trailing={
                  counts[tab] > 0 ? (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {counts[tab]}
                    </span>
                  ) : undefined
                }
              />
            ))}
            {onArchivedScopeChange && (
              <Picker.Item
                value={ARCHIVED_SCOPE_VALUE}
                label={t('page.tabs.archived')}
                indicator="check"
                trailing={
                  archivedCount > 0 ? (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {archivedCount}
                    </span>
                  ) : undefined
                }
              />
            )}
          </Picker.List>
        </Picker.Content>
      </Picker>

      {/* Saved Filter Pills */}
      {savedFilters.length > 0 && (
        <div className="flex items-center shrink-0 rounded-[5px] overflow-clip border border-border">
          {savedFilters.map((sf) => {
            const isActive = activeSavedFilterId === sf.id
            return (
              <div
                key={sf.id}
                data-testid="saved-filter-pill"
                className={cn(
                  'group/pill flex items-center whitespace-nowrap transition-colors',
                  'not-first:border-s not-first:border-border',
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
      )}

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
