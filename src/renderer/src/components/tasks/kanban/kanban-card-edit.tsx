import { useState, useCallback, useRef, useEffect } from 'react'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusSelect } from '@/components/tasks/status-select'
import { PrioritySelect } from '@/components/tasks/priority-select'
import { DueDatePicker } from '@/components/tasks/due-date-picker'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Status } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface KanbanCardEditProps {
  task: Task
  statuses: Status[]
  onSave: (taskId: string, updates: Partial<Task>) => void
  onCancel: () => void
}

// ============================================================================
// KANBAN CARD EDIT COMPONENT
// ============================================================================

export const KanbanCardEdit = ({
  task,
  statuses,
  onSave,
  onCancel
}: KanbanCardEditProps): React.JSX.Element => {
  // Form state
  const [title, setTitle] = useState(task.title)
  const [statusId, setStatusId] = useState(task.statusId)
  const [priority, setPriority] = useState<Priority>(task.priority)
  const [dueDate, setDueDate] = useState<Date | null>(task.dueDate)
  const [dueTime, setDueTime] = useState<string | null>(task.dueTime)

  const titleInputRef = useRef<HTMLInputElement>(null)

  // Focus title input and select all text on mount
  useEffect(() => {
    if (titleInputRef.current) {
      titleInputRef.current.focus()
      titleInputRef.current.select()
    }
  }, [])

  // Check if form has changes
  const hasChanges = useCallback((): boolean => {
    return (
      title !== task.title ||
      statusId !== task.statusId ||
      priority !== task.priority ||
      dueDate?.getTime() !== task.dueDate?.getTime() ||
      dueTime !== task.dueTime
    )
  }, [title, statusId, priority, dueDate, dueTime, task])

  // Handle save
  const handleSave = useCallback((): void => {
    if (!title.trim()) return

    // Check if any changes were made
    if (!hasChanges()) {
      onCancel()
      return
    }

    // Find the target status to determine if it's a "done" status
    const targetStatus = statuses.find((s) => s.id === statusId)
    const isDone = targetStatus?.type === 'done'
    const wasDone = statuses.find((s) => s.id === task.statusId)?.type === 'done'

    const updates: Partial<Task> = {
      title: title.trim(),
      statusId,
      priority,
      dueDate,
      dueTime
    }

    // Handle completedAt based on status change
    if (isDone && !wasDone) {
      updates.completedAt = new Date()
    } else if (!isDone && wasDone) {
      updates.completedAt = null
    }

    // Save directly without animation
    onSave(task.id, updates)
  }, [title, statusId, priority, dueDate, dueTime, task, statuses, hasChanges, onSave, onCancel])

  // Handle form submission
  const handleSubmit = useCallback(
    (e: React.FormEvent): void => {
      e.preventDefault()
      handleSave()
    },
    [handleSave]
  )

  // Keyboard handler for the form
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      // Cmd/Ctrl + Enter to save
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        handleSave()
        return
      }

      // Escape to cancel
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
    },
    [handleSave, onCancel]
  )

  return (
    <div
      className={cn(
        'w-full max-w-[260px] box-border overflow-hidden rounded-lg border-2 border-primary bg-card p-2 shadow-md',
        'mx-auto'
      )}
    >
      <form
        onSubmit={handleSubmit}
        onKeyDown={handleKeyDown}
        className="flex w-full flex-col gap-2 overflow-hidden"
      >
        {/* Title Input */}
        <Input
          ref={titleInputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Task title..."
          className="h-8 text-sm font-medium"
          aria-label="Task title"
        />

        {/* Status & Priority Row */}
        <div className="flex min-w-0 gap-1.5">
          <div className="min-w-0 flex-1">
            <StatusSelect value={statusId} onChange={setStatusId} statuses={statuses} compact />
          </div>
          <div className="min-w-0 flex-1">
            <PrioritySelect value={priority} onChange={setPriority} compact />
          </div>
        </div>

        {/* Due Date */}
        <DueDatePicker
          date={dueDate}
          time={dueTime}
          onDateChange={setDueDate}
          onTimeChange={setDueTime}
          className="h-8 w-full text-sm"
        />

        {/* Footer with keyboard hints and buttons */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
          {/* Keyboard hints */}
          <div className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
            <kbd className="inline-flex h-4 items-center justify-center rounded border border-border bg-muted px-1 font-medium">
              ⌘↵
            </kbd>
            <span>save</span>
            <span className="mx-1">·</span>
            <kbd className="inline-flex h-4 items-center justify-center rounded border border-border bg-muted px-1 font-medium">
              Esc
            </kbd>
            <span>cancel</span>
          </div>

          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCancel}
              className="h-6 px-2 text-xs whitespace-nowrap"
            >
              <X className="mr-1 size-3" />
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!title.trim()}
              className="h-6 px-3 text-xs whitespace-nowrap"
            >
              Save
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}

export default KanbanCardEdit
