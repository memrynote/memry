import React, { useMemo, useState } from 'react'
import { X, ChevronDown } from 'lucide-react'

import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SelectionCheckbox } from '@/components/tasks/bulk-actions'
import { SubtaskBadge } from '@/components/tasks/subtask-badge'
import { cn } from '@/lib/utils'
import { formatDayName } from '@/lib/task-utils'
import { getSubtasks, calculateProgress } from '@/lib/subtask-utils'
import { priorityConfig, type Task } from '@/data/sample-tasks'

interface DayDetailPopoverProps {
  date: Date | null
  tasks: Task[]
  allTasks?: Task[]
  isOpen: boolean
  onClose: () => void
  onTaskClick: (taskId: string) => void
  onToggleComplete: (taskId: string) => void
  onAddTask: (date: Date) => void
  // Selection props
  isSelectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (taskId: string) => void
}

const sortTasks = (tasks: Task[]): Task[] => {
  return [...tasks].sort((a, b) => {
    if (a.dueTime && b.dueTime && a.dueTime !== b.dueTime) {
      return a.dueTime.localeCompare(b.dueTime)
    }
    if (a.dueTime && !b.dueTime) return -1
    if (!a.dueTime && b.dueTime) return 1

    const pa = priorityConfig[a.priority].order
    const pb = priorityConfig[b.priority].order
    if (pa !== pb) return pa - pb

    return a.title.localeCompare(b.title)
  })
}

export const DayDetailPopover = ({
  date,
  tasks,
  allTasks = [],
  isOpen,
  onClose,
  onTaskClick,
  onToggleComplete,
  onAddTask,
  // Selection props
  isSelectionMode = false,
  selectedIds,
  onToggleSelect
}: DayDetailPopoverProps): React.JSX.Element | null => {
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set())
  const sortedTasks = useMemo(() => sortTasks(tasks), [tasks])
  const title = date
    ? `${formatDayName(date)}, ${date.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric'
      })}`
    : ''

  const handleAdd = (): void => {
    if (!date) return
    onAddTask(date)
    onClose()
  }

  const handleTaskClick = (taskId: string): void => {
    // In selection mode, clicking toggles selection
    if (isSelectionMode && onToggleSelect) {
      onToggleSelect(taskId)
      return
    }
    onTaskClick(taskId)
  }

  const handleSelectionCheckboxChange = (taskId: string): void => {
    onToggleSelect?.(taskId)
  }

  const toggleExpanded = (taskId: string): void => {
    setExpandedTasks((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) {
        next.delete(taskId)
      } else {
        next.add(taskId)
      }
      return next
    })
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h3 className="text-base font-semibold leading-tight">{title}</h3>
            <p className="text-sm text-muted-foreground">
              {tasks.length} task{tasks.length !== 1 ? 's' : ''}
            </p>
          </div>
          <button
            type="button"
            className="rounded p-2 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onClose}
            aria-label="Close day details"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="max-h-[320px] overflow-y-auto px-4 py-3">
          {sortedTasks.length === 0 && (
            <p className="text-sm text-muted-foreground">No tasks for this day.</p>
          )}

          <div className="space-y-2">
            {sortedTasks.map((task) => {
              const isCheckedForSelection = selectedIds?.has(task.id) ?? false
              const taskSubtasks = allTasks.length > 0 ? getSubtasks(task.id, allTasks) : []
              const taskHasSubtasks = taskSubtasks.length > 0
              const subtaskProgress = calculateProgress(taskSubtasks)
              const isExpanded = expandedTasks.has(task.id)

              return (
                <div key={task.id}>
                  {/* Parent task row */}
                  <button
                    type="button"
                    className={cn(
                      'group flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm',
                      'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      isCheckedForSelection && 'bg-primary/10 hover:bg-primary/15'
                    )}
                    onClick={() => handleTaskClick(task.id)}
                  >
                    {/* Expand/collapse toggle for tasks with subtasks */}
                    {taskHasSubtasks ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleExpanded(task.id)
                        }}
                        className="shrink-0 p-0.5 hover:bg-accent rounded"
                        aria-label={isExpanded ? 'Collapse subtasks' : 'Expand subtasks'}
                      >
                        <ChevronDown
                          className={cn(
                            'size-4 text-muted-foreground transition-transform',
                            isExpanded && 'rotate-180'
                          )}
                        />
                      </button>
                    ) : (
                      <span className="w-5 shrink-0" />
                    )}

                    {/* Selection checkbox - visible only in selection mode */}
                    {onToggleSelect && isSelectionMode && (
                      <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                        <SelectionCheckbox
                          checked={isCheckedForSelection}
                          onChange={() => handleSelectionCheckboxChange(task.id)}
                          aria-label={`Select ${task.title}`}
                        />
                      </div>
                    )}

                    {/* Task completion checkbox */}
                    <div onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={!!task.completedAt}
                        onCheckedChange={() => onToggleComplete(task.id)}
                        aria-label="Toggle complete"
                      />
                    </div>
                    <div className="flex flex-1 items-center gap-2">
                      <span
                        className={cn(
                          'w-12 shrink-0 tabular-nums text-xs',
                          task.dueTime ? 'text-muted-foreground' : 'text-muted-foreground/60'
                        )}
                      >
                        {task.dueTime || '—'}
                      </span>
                      {task.priority !== 'none' && (
                        <span
                          className="block size-2 shrink-0 rounded-full"
                          style={{
                            backgroundColor: priorityConfig[task.priority].color || undefined
                          }}
                          aria-hidden="true"
                        />
                      )}
                      <span
                        className={cn(
                          'truncate text-sm',
                          task.completedAt && 'line-through text-muted-foreground'
                        )}
                      >
                        {task.title}
                      </span>
                      {task.isRepeating && <span className="shrink-0 text-xs opacity-60">🔄</span>}
                    </div>
                  </button>

                  {/* Subtask badge (if has subtasks and not expanded) */}
                  {taskHasSubtasks && !isExpanded && (
                    <div className="ml-7 pl-6 py-1">
                      <SubtaskBadge
                        completed={subtaskProgress.completed}
                        total={subtaskProgress.total}
                        size="sm"
                      />
                    </div>
                  )}

                  {/* Expanded subtasks list */}
                  {taskHasSubtasks && isExpanded && (
                    <div className="ml-7 border-l border-border/50 pl-2 space-y-1 py-1">
                      {taskSubtasks.map((subtask, index) => {
                        const isLastSubtask = index === taskSubtasks.length - 1

                        return (
                          <button
                            key={subtask.id}
                            type="button"
                            onClick={() => handleTaskClick(subtask.id)}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm',
                              'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                            )}
                          >
                            {/* Tree connector */}
                            <span className="text-muted-foreground/50 text-xs font-mono shrink-0">
                              {isLastSubtask ? '└─' : '├─'}
                            </span>

                            {/* Subtask checkbox */}
                            <div onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                checked={!!subtask.completedAt}
                                onCheckedChange={() => onToggleComplete(subtask.id)}
                                aria-label="Toggle subtask complete"
                              />
                            </div>

                            {/* Subtask title */}
                            <span
                              className={cn(
                                'truncate text-sm',
                                subtask.completedAt && 'line-through text-muted-foreground'
                              )}
                            >
                              {subtask.title}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="border-t border-border px-4 py-3">
          <Button className="w-full" onClick={handleAdd}>
            + Add task for this day
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default DayDetailPopover
