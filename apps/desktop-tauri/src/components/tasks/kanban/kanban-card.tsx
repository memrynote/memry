import React, { forwardRef } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Link2 } from '@/lib/icons'

import { cn } from '@/lib/utils'
import { useDragContext } from '@/contexts/drag-context'
import { RepeatIndicator } from '@/components/tasks/repeat-indicator'
import { SubtaskProgressIndicator } from '@/components/tasks/subtask-progress-indicator'
import { priorityConfig, type Priority, type Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'
import { formatDueDate } from '@/lib/task-utils'
import { getSubtasks } from '@/lib/subtask-utils'

interface KanbanCardProps {
  task: Task
  project?: Project
  allTasks: Task[]
  columnId?: string
  sectionTaskIds?: string[]
  isSelected?: boolean
  isFocused?: boolean
  isDone?: boolean
  isSelectionMode?: boolean
  showProjectBadge?: boolean
  onClick?: () => void
  onToggleComplete?: () => void
  onToggleSelect?: () => void
}

interface KanbanCardContentProps extends KanbanCardProps {
  isDragging?: boolean
  style?: React.CSSProperties
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attributes?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listeners?: any
  setNodeRef?: (node: HTMLElement | null) => void
}

export const KanbanCardContent = forwardRef<HTMLDivElement, KanbanCardContentProps>(
  (
    {
      task,
      project,
      allTasks,
      isSelected = false,
      isFocused = false,
      isDone = false,
      isDragging = false,
      isSelectionMode = false,
      showProjectBadge = true,
      onClick,
      onToggleComplete,
      onToggleSelect,
      style,
      attributes,
      listeners,
      setNodeRef
    },
    ref
  ) => {
    const { dragState } = useDragContext()
    const isJustDropped = dragState.lastDroppedId === task.id

    const subtasks = getSubtasks(task.id, allTasks)
    const completedSubtasks = subtasks.filter((s) => s.completedAt !== null)
    const hasSubtasks = subtasks.length > 0
    const hasLinkedNotes = task.linkedNoteIds.length > 0

    const dueDateInfo = task.dueDate ? formatDueDate(task.dueDate, task.dueTime) : null
    const isOverdue = dueDateInfo?.status === 'overdue'

    const handleClick = (e: React.MouseEvent): void => {
      if (isSelectionMode && onToggleSelect) {
        e.stopPropagation()
        onToggleSelect()
        return
      }
      onClick?.()
    }

    const handleKeyDown = (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter') {
        e.preventDefault()
        onClick?.()
      } else if (e.key === ' ') {
        e.preventDefault()
        if (isSelectionMode && onToggleSelect) {
          onToggleSelect()
        } else {
          onToggleComplete?.()
        }
      }
    }

    return (
      <div
        ref={(node) => {
          if (typeof ref === 'function') ref(node)
          else if (ref) ref.current = node
          setNodeRef?.(node)
        }}
        role="button"
        tabIndex={0}
        aria-selected={isSelected}
        aria-label={task.title}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        style={style}
        className={cn(
          'group flex cursor-grab rounded-md overflow-clip transition-all duration-150',
          isDragging && 'border-[1.5px] border-dashed border-primary/30 bg-primary/[0.03]',
          !isDragging && 'border border-solid',
          !isDragging &&
            !isDone &&
            'bg-card border-border hover:bg-accent/30 hover:shadow-[var(--shadow-card)]',
          !isDragging && isDone && 'bg-muted/40 border-border/50',
          isSelected &&
            !isDragging &&
            'ring-1 ring-inset ring-primary/50 border-primary bg-primary/5',
          isFocused &&
            !isDragging &&
            !isSelected &&
            'ring-1 ring-inset ring-primary/40 border-primary/40',
          'focus-visible:outline-none',
          isJustDropped && 'animate-drop-flash'
        )}
        {...attributes}
        {...listeners}
      >
        {/* Content area */}
        <div
          className={cn(
            'flex flex-1 flex-col gap-1.5 py-2.5 px-3 min-w-0',
            isDragging && 'invisible'
          )}
        >
          {/* Title row */}
          <div className="flex items-start gap-1.5">
            <span
              className={cn(
                'text-[13px] font-medium line-clamp-2',
                isDone ? 'text-muted-foreground/60 line-through' : 'text-foreground/90'
              )}
            >
              {task.title}
            </span>
          </div>

          {/* Metadata row */}
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Priority badge (skip for 'none' and done tasks) */}
            {task.priority !== 'none' && !isDone && <PriorityPill priority={task.priority} />}

            {/* Overdue badge */}
            {isOverdue && !isDone && (
              <span className="inline-flex items-center rounded-sm px-[7px] py-0.5 text-[11px] font-medium bg-task-due-overdue/[0.08] text-task-due-overdue">
                {dueDateInfo?.label}
              </span>
            )}

            {/* Due date */}
            {dueDateInfo && !isOverdue && !isDone && (
              <span className="text-text-tertiary text-[11px]">{dueDateInfo.label}</span>
            )}

            {/* Repeat indicator */}
            {task.isRepeating && task.repeatConfig && (
              <RepeatIndicator config={task.repeatConfig} size="sm" />
            )}

            {/* Project badge */}
            {project && showProjectBadge && (
              <span className="inline-flex items-center gap-1 text-text-tertiary text-[11px]">
                <span
                  className="w-[6px] h-[6px] rounded-full shrink-0"
                  style={{ backgroundColor: project.color }}
                />
                <span className="truncate max-w-[80px]">{project.name}</span>
              </span>
            )}

            {hasSubtasks && (
              <SubtaskProgressIndicator
                completed={completedSubtasks.length}
                total={subtasks.length}
              />
            )}

            {/* Linked notes */}
            {hasLinkedNotes && (
              <span className="inline-flex items-center gap-0.5 text-text-tertiary text-[11px]">
                <Link2 className="w-3 h-3" />
                {task.linkedNoteIds.length}
              </span>
            )}

            {/* Completion time for done cards */}
            {isDone && task.completedAt && (
              <span className="text-text-tertiary text-[11px]">
                {formatCompletionTime(task.completedAt)}
              </span>
            )}
          </div>
        </div>
      </div>
    )
  }
)

KanbanCardContent.displayName = 'KanbanCardContent'

const PriorityPill = ({ priority }: { priority: Priority }): React.JSX.Element | null => {
  const config = priorityConfig[priority]
  if (!config.color || !config.label) return null

  return (
    <span
      className="inline-flex items-center rounded-sm px-[7px] py-0.5 text-[11px] font-medium"
      style={{ backgroundColor: config.bgColor ?? undefined, color: config.color }}
    >
      {config.label}
    </span>
  )
}

const formatCompletionTime = (date: Date): string => {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

export const SortableKanbanCard = (props: KanbanCardProps): React.JSX.Element => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.task.id,
    data: {
      type: 'task',
      task: props.task,
      sourceType: 'kanban',
      columnId: props.columnId,
      sectionId: props.columnId,
      sectionTaskIds: props.sectionTaskIds
    }
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition
  }

  return (
    <KanbanCardContent
      {...props}
      isDragging={isDragging}
      style={style}
      attributes={attributes}
      listeners={listeners}
      setNodeRef={setNodeRef}
    />
  )
}

export default SortableKanbanCard
