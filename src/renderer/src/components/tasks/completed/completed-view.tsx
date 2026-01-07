import { useState, useMemo } from 'react'
import { Archive } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  getCompletedTasks,
  getCompletionStats,
  groupCompletedByPeriod,
  filterCompletedBySearch,
  completionPeriodConfig,
  type CompletionPeriod
} from '@/lib/task-utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { CompletedTaskRow } from './completed-task-row'
import { CompletionStats } from './completion-stats'
import { CompletedSearchInput } from './completed-search-input'
import { CompletedEmptyState } from './completed-empty-state'
import type { Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface CompletedViewProps {
  tasks: Task[]
  projects: Project[]
  onUncomplete: (taskId: string) => void
  onArchive: (taskId: string) => void
  onDelete: (taskId: string) => void
  onViewArchived: () => void
  onOpenClearMenu: () => void
  className?: string
}

interface TaskSectionHeaderProps {
  title: string
  count: number
  variant?: 'default' | 'accent' | 'muted'
  className?: string
}

// ============================================================================
// TASK SECTION HEADER
// ============================================================================

const TaskSectionHeader = ({
  title,
  count,
  variant = 'default',
  className
}: TaskSectionHeaderProps): React.JSX.Element => {
  return (
    <div className={cn('flex items-center justify-between py-2 px-1', className)}>
      <span
        className={cn(
          'text-xs font-semibold uppercase tracking-wider',
          variant === 'accent' && 'text-emerald-600 dark:text-emerald-500',
          variant === 'muted' && 'text-text-tertiary',
          variant === 'default' && 'text-text-secondary'
        )}
      >
        {title}
      </span>
      <span
        className={cn(
          'text-xs tabular-nums rounded-full px-2 py-0.5',
          variant === 'accent' &&
            'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-400',
          variant === 'muted' && 'bg-muted text-text-tertiary',
          variant === 'default' && 'bg-muted text-text-secondary'
        )}
      >
        {count}
      </span>
    </div>
  )
}

// ============================================================================
// COMPLETED VIEW
// ============================================================================

export const CompletedView = ({
  tasks,
  projects,
  onUncomplete,
  onArchive,
  onDelete,
  onViewArchived,
  onOpenClearMenu,
  className
}: CompletedViewProps): React.JSX.Element => {
  const [searchQuery, setSearchQuery] = useState('')

  // Get completed (non-archived) tasks
  const completedTasks = useMemo(() => getCompletedTasks(tasks), [tasks])

  // Calculate stats (on all completed, not filtered)
  const stats = useMemo(() => getCompletionStats(completedTasks), [completedTasks])

  // Filter by search
  const filteredTasks = useMemo(
    () => filterCompletedBySearch(completedTasks, searchQuery),
    [completedTasks, searchQuery]
  )

  // Group filtered tasks by period
  const groupedTasks = useMemo(() => groupCompletedByPeriod(filteredTasks), [filteredTasks])

  // Check for empty states
  const hasCompletedTasks = completedTasks.length > 0
  const hasFilteredResults = filteredTasks.length > 0
  const isSearching = searchQuery.trim().length > 0

  // Periods in display order
  const periods: CompletionPeriod[] = ['today', 'yesterday', 'earlierThisWeek', 'lastWeek', 'older']

  // Get project by ID
  const getProject = (projectId: string): Project | undefined => {
    return projects.find((p) => p.id === projectId)
  }

  // Get variant for period header
  const getPeriodVariant = (period: CompletionPeriod): 'default' | 'accent' | 'muted' => {
    const config = completionPeriodConfig[period]
    if (config.accentColor) return 'accent'
    if (config.isMuted) return 'muted'
    return 'default'
  }

  return (
    <ScrollArea className={cn('flex-1', className)}>
      <div className="p-4 space-y-6">
        {/* Search and Actions Bar */}
        <div className="flex items-center gap-3">
          <CompletedSearchInput value={searchQuery} onChange={setSearchQuery} className="flex-1" />
          <Button variant="outline" size="sm" onClick={onViewArchived} className="shrink-0">
            <Archive className="size-4 mr-2" aria-hidden="true" />
            View Archived
          </Button>
        </div>

        {/* Stats Panel (always show if there are completed tasks) */}
        {hasCompletedTasks && <CompletionStats stats={stats} />}

        {/* Empty state: No completed tasks at all */}
        {!hasCompletedTasks && <CompletedEmptyState variant="no-completed" />}

        {/* Empty state: No search results */}
        {hasCompletedTasks && isSearching && !hasFilteredResults && (
          <CompletedEmptyState variant="no-results" searchQuery={searchQuery} />
        )}

        {/* Grouped task list */}
        {hasFilteredResults && (
          <div className="space-y-4">
            {periods.map((period) => {
              const periodTasks = groupedTasks[period]
              if (periodTasks.length === 0) return null

              const config = completionPeriodConfig[period]

              return (
                <section key={period}>
                  <TaskSectionHeader
                    title={config.label}
                    count={periodTasks.length}
                    variant={getPeriodVariant(period)}
                  />
                  <div className="divide-y divide-border/50">
                    {periodTasks.map((task) => (
                      <CompletedTaskRow
                        key={task.id}
                        task={task}
                        project={getProject(task.projectId)}
                        onUncomplete={onUncomplete}
                        onArchive={onArchive}
                        onDelete={onDelete}
                      />
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        )}

        {/* Footer with bulk actions */}
        {hasCompletedTasks && (
          <div className="flex items-center justify-between pt-4 border-t border-border">
            <span className="text-sm text-text-tertiary">
              {completedTasks.length} completed task{completedTasks.length !== 1 ? 's' : ''}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenClearMenu}
              className="text-text-tertiary hover:text-text-primary"
            >
              Clear completed...
            </Button>
          </div>
        )}
      </div>
    </ScrollArea>
  )
}

export default CompletedView
