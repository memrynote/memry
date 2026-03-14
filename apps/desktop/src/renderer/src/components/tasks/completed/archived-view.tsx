import { useState, useMemo } from 'react'
import { ArrowLeft, Trash2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { getArchivedTasks, groupArchivedByMonth, filterCompletedBySearch } from '@/lib/task-utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { ArchivedTaskRow } from './archived-task-row'
import { CompletedSearchInput } from './completed-search-input'
import { ArchivedEmptyState } from './archived-empty-state'
import type { Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface ArchivedViewProps {
  tasks: Task[]
  projects: Project[]
  onBack: () => void
  onRestore: (taskId: string) => void
  onDelete: (taskId: string) => void
  onDeleteAll: () => void
  className?: string
}

// ============================================================================
// ARCHIVED VIEW
// ============================================================================

export const ArchivedView = ({
  tasks,
  projects,
  onBack,
  onRestore,
  onDelete,
  onDeleteAll,
  className
}: ArchivedViewProps): React.JSX.Element => {
  const [searchQuery, setSearchQuery] = useState('')

  // Get archived tasks
  const archivedTasks = useMemo(() => getArchivedTasks(tasks), [tasks])

  // Filter by search
  const filteredTasks = useMemo(
    () => filterCompletedBySearch(archivedTasks, searchQuery),
    [archivedTasks, searchQuery]
  )

  // Group filtered tasks by month
  const groupedByMonth = useMemo(() => groupArchivedByMonth(filteredTasks), [filteredTasks])

  // Check for empty states
  const hasArchivedTasks = archivedTasks.length > 0
  const hasFilteredResults = filteredTasks.length > 0
  const isSearching = searchQuery.trim().length > 0

  // Get project by ID
  const getProject = (projectId: string): Project | undefined => {
    return projects.find((p) => p.id === projectId)
  }

  return (
    <ScrollArea className={cn('flex-1', className)}>
      <div className="p-4 space-y-4">
        {/* Header with Back button */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              className="shrink-0"
              aria-label="Back to completed"
            >
              <ArrowLeft className="size-4" />
            </Button>
            <div>
              <h2 className="text-lg font-semibold text-text-primary">Archived Tasks</h2>
              <p className="text-sm text-text-tertiary">
                {archivedTasks.length} task{archivedTasks.length !== 1 ? 's' : ''} archived
              </p>
            </div>
          </div>
          {hasArchivedTasks && (
            <Button
              variant="outline"
              size="sm"
              onClick={onDeleteAll}
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="size-4 mr-2" aria-hidden="true" />
              Delete All
            </Button>
          )}
        </div>

        {/* Search */}
        {hasArchivedTasks && (
          <CompletedSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search archived tasks..."
          />
        )}

        {/* Empty state: No archived tasks */}
        {!hasArchivedTasks && <ArchivedEmptyState variant="no-archived" />}

        {/* Empty state: No search results */}
        {hasArchivedTasks && isSearching && !hasFilteredResults && (
          <ArchivedEmptyState variant="no-results" searchQuery={searchQuery} />
        )}

        {/* Grouped by month */}
        {hasFilteredResults && (
          <div className="space-y-6">
            {groupedByMonth.map((group) => (
              <section key={group.monthKey}>
                <div className="flex items-center justify-between py-2 px-1 mb-1">
                  <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
                    {group.label}
                  </span>
                  <span className="text-xs tabular-nums text-text-tertiary">
                    {group.tasks.length} task{group.tasks.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="divide-y divide-border/50 rounded-sm border border-border">
                  {group.tasks.map((task) => (
                    <ArchivedTaskRow
                      key={task.id}
                      task={task}
                      project={getProject(task.projectId)}
                      onRestore={onRestore}
                      onDelete={onDelete}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  )
}

export default ArchivedView
