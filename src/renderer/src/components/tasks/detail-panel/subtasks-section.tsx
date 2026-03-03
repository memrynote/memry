import { useState, useRef } from 'react'
import { Plus } from 'lucide-react'

import { cn } from '@/lib/utils'

import { BulkSubtaskActionsMenu } from './bulk-subtask-actions-menu'
import { SubtasksEmptyState } from './subtasks-empty-state'
import { SortableSubtaskDetailList } from './sortable-subtask-detail-list'
import type { Task } from '@/data/sample-tasks'
import type { SubtaskProgress } from '@/lib/subtask-utils'

// ============================================================================
// TYPES
// ============================================================================

interface SubtasksSectionProps {
  parentTask: Task
  subtasks: Task[]
  progress: SubtaskProgress
  onAddSubtask: (parentId: string, title: string) => void
  onBulkAddSubtasks: (parentId: string, titles: string[]) => void
  onUpdateSubtask: (subtaskId: string, updates: Partial<Task>) => void
  onToggleSubtaskComplete: (subtaskId: string) => void
  onDeleteSubtask: (subtaskId: string) => void
  onReorderSubtasks: (parentId: string, newOrder: string[]) => void
  onPromoteSubtask: (subtaskId: string) => void
  onCompleteAllSubtasks: (parentId: string) => void
  onMarkAllSubtasksIncomplete: (parentId: string) => void
  onOpenBulkDueDateDialog: (parentId: string) => void
  onOpenBulkPriorityDialog: (parentId: string) => void
  onOpenDeleteAllSubtasksDialog: (parentId: string) => void
}

// ============================================================================
// ADD SUBTASK INPUT (without tree connector for detail panel)
// ============================================================================

interface DetailAddSubtaskInputProps {
  parentId: string
  onAdd: (parentId: string, title: string) => void
}

const DetailAddSubtaskInput = ({
  parentId,
  onAdd
}: DetailAddSubtaskInputProps): React.JSX.Element => {
  const [isActive, setIsActive] = useState(false)
  const [title, setTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = (): void => {
    if (title.trim()) {
      onAdd(parentId, title.trim())
      setTitle('')
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && title.trim()) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      setTitle('')
      setIsActive(false)
      inputRef.current?.blur()
    }
  }

  return (
    <div
      className={cn(
        'flex items-center rounded-lg border transition-colors mt-2',
        isActive
          ? 'border-ring bg-background shadow-sm'
          : 'border-dashed border-border hover:border-muted-foreground/50'
      )}
    >
      <Plus
        className={cn(
          'w-4 h-4 ml-3 shrink-0',
          isActive ? 'text-muted-foreground' : 'text-muted-foreground/60'
        )}
        aria-hidden="true"
      />

      <input
        ref={inputRef}
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onFocus={() => setIsActive(true)}
        onBlur={() => {
          if (!title) setIsActive(false)
        }}
        onKeyDown={handleKeyDown}
        placeholder="Add subtask..."
        className={cn(
          'flex-1 px-2 py-2 text-sm bg-transparent outline-none',
          'placeholder:text-muted-foreground/60'
        )}
        aria-label="Add subtask"
      />

      {isActive && title && (
        <span className="text-xs text-muted-foreground mr-3 shrink-0">Enter to add</span>
      )}
    </div>
  )
}

// ============================================================================
// SUBTASKS SECTION COMPONENT
// ============================================================================

export const SubtasksSection = ({
  parentTask,
  subtasks,
  progress,
  onAddSubtask,
  onBulkAddSubtasks,
  onUpdateSubtask,
  onToggleSubtaskComplete,
  onDeleteSubtask,
  onReorderSubtasks,
  onPromoteSubtask,
  onCompleteAllSubtasks,
  onMarkAllSubtasksIncomplete,
  onOpenBulkDueDateDialog,
  onOpenBulkPriorityDialog,
  onOpenDeleteAllSubtasksDialog
}: SubtasksSectionProps): React.JSX.Element => {
  const hasSubtasks = subtasks.length > 0
  const hasIncomplete = progress.completed < progress.total
  const hasComplete = progress.completed > 0

  const handleBulkAdd = (titles: string[]): void => {
    onBulkAddSubtasks(parentTask.id, titles)
  }

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Subtasks
        </h3>
        <div className="flex items-center gap-2">
          {hasSubtasks && (
            <span className="text-xs text-muted-foreground">
              {progress.completed}/{progress.total} done
            </span>
          )}
          <BulkSubtaskActionsMenu
            subtaskCount={subtasks.length}
            hasIncomplete={hasIncomplete}
            hasComplete={hasComplete}
            onCompleteAll={() => onCompleteAllSubtasks(parentTask.id)}
            onMarkAllIncomplete={() => onMarkAllSubtasksIncomplete(parentTask.id)}
            onSetDueDate={() => onOpenBulkDueDateDialog(parentTask.id)}
            onSetPriority={() => onOpenBulkPriorityDialog(parentTask.id)}
            onDeleteAll={() => onOpenDeleteAllSubtasksDialog(parentTask.id)}
          />
        </div>
      </div>

      {/* Subtask list or empty state */}
      {hasSubtasks ? (
        <>
          <SortableSubtaskDetailList
            parentId={parentTask.id}
            subtasks={subtasks}
            onUpdate={onUpdateSubtask}
            onToggleComplete={onToggleSubtaskComplete}
            onDelete={onDeleteSubtask}
            onReorder={onReorderSubtasks}
            onPromote={onPromoteSubtask}
          />
          <DetailAddSubtaskInput parentId={parentTask.id} onAdd={onAddSubtask} />
        </>
      ) : (
        <SubtasksEmptyState
          parentId={parentTask.id}
          onAddFirst={(title) => onAddSubtask(parentTask.id, title)}
          onBulkAdd={handleBulkAdd}
        />
      )}
    </div>
  )
}

export default SubtasksSection
