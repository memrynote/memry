import { useRef, useEffect } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'

import { cn } from '@/lib/utils'
import { formatDueDate } from '@/lib/task-utils'
import { hasSubtasks, type SubtaskProgress } from '@/lib/subtask-utils'
import { priorityConfig } from '@/data/sample-tasks'
import { TaskCheckbox } from '@/components/tasks/task-badges'
import { RepeatIndicator } from '@/components/tasks/repeat-indicator'
import { SelectionCheckbox } from '@/components/tasks/bulk-actions'
import { ExpandChevron } from '@/components/tasks/expand-chevron'
import { SortableSubtaskList } from '@/components/tasks/sortable-subtask-list'
import type { Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

interface SortableParentTaskRowProps {
  task: Task
  project: Project
  sectionId: string
  subtasks: Task[]
  progress: SubtaskProgress
  isExpanded: boolean
  isCompleted: boolean
  isSelected?: boolean
  showProjectBadge?: boolean
  onToggleExpand: (taskId: string) => void
  onToggleComplete: (taskId: string) => void
  onToggleSubtaskComplete?: (subtaskId: string) => void
  onClick?: (taskId: string) => void
  className?: string
  isSelectionMode?: boolean
  isCheckedForSelection?: boolean
  onToggleSelect?: (taskId: string) => void
  onShiftSelect?: (taskId: string) => void
  onAddSubtask?: (parentId: string, title: string) => void
  onReorderSubtasks?: (parentId: string, newOrder: string[]) => void
  accentClass?: string
}

export const SortableParentTaskRow = ({
  task,
  project,
  sectionId,
  subtasks,
  progress,
  isExpanded,
  isCompleted,
  isSelected = false,
  showProjectBadge = false,
  onToggleExpand,
  onToggleComplete,
  onToggleSubtaskComplete,
  onClick,
  className,
  isSelectionMode = false,
  isCheckedForSelection = false,
  onToggleSelect,
  onShiftSelect,
  onAddSubtask,
  onReorderSubtasks
}: SortableParentTaskRowProps): React.JSX.Element => {
  const rowRef = useRef<HTMLDivElement>(null)
  const taskHasSubtasks = hasSubtasks(task)
  const priorityColor = priorityConfig[task.priority]?.color

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', task, sectionId, sourceType: 'list' }
  })

  useEffect(() => {
    if (isSelected && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [isSelected])

  const setRefs = (node: HTMLDivElement | null): void => {
    setNodeRef(node)
    ;(rowRef as React.RefObject<HTMLDivElement | null>).current = node
  }

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 200ms ease-out'
  }

  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const isOverdue = formattedDate?.status === 'overdue' && !isCompleted

  const handleRowClick = (e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest('[data-drag-handle]')) return
    if ((e.target as HTMLElement).closest('[data-expand-button]')) return

    if (e.shiftKey && isSelectionMode && onShiftSelect) {
      e.preventDefault()
      onShiftSelect(task.id)
      return
    }
    if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
      e.preventDefault()
      onToggleSelect(task.id)
      return
    }
    if (isSelectionMode && onToggleSelect) {
      onToggleSelect(task.id)
      return
    }
    onClick?.(task.id)
  }

  const handleRowKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && onClick) {
      e.preventDefault()
      onClick(task.id)
    }
    if (taskHasSubtasks) {
      if (e.key === 'ArrowRight' && !isExpanded) {
        e.preventDefault()
        onToggleExpand(task.id)
      }
      if (e.key === 'ArrowLeft' && isExpanded) {
        e.preventDefault()
        onToggleExpand(task.id)
      }
    }
  }

  const handleExpandToggle = (): void => {
    if (taskHasSubtasks) onToggleExpand(task.id)
  }

  return (
    <div className={cn('group relative', className)}>
      <div
        ref={setRefs}
        style={{
          ...style,
          borderLeftColor: priorityColor && !isCompleted ? priorityColor : 'transparent',
          backgroundColor: priorityColor && !isCompleted ? `${priorityColor}05` : undefined
        }}
        role="button"
        tabIndex={onClick ? 0 : -1}
        onClick={handleRowClick}
        onKeyDown={onClick ? handleRowKeyDown : undefined}
        className={cn(
          'flex items-center gap-2.5 border-l-[3px] rounded-r-md',
          'py-2 px-3 transition-all duration-150',
          'hover:bg-accent/50',
          onClick &&
            'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          isCheckedForSelection && 'bg-primary/10 hover:bg-primary/15',
          isSelected && !isCheckedForSelection && 'bg-primary/10 ring-2 ring-primary/30',
          isDragging && 'opacity-50 shadow-lg ring-2 ring-primary bg-background z-10'
        )}
        aria-label={`Task: ${task.title}${isCompleted ? ', completed' : ''}${taskHasSubtasks ? `, ${subtasks.length} subtasks` : ''}`}
      >
        {/* Drag Handle — absolute overlay, visible on hover */}
        <button
          type="button"
          data-drag-handle
          {...attributes}
          {...listeners}
          className={cn(
            'absolute left-0 top-0 bottom-0 w-5 items-center justify-center',
            'cursor-grab touch-none text-muted-foreground/50',
            'hover:text-muted-foreground active:cursor-grabbing',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded',
            'hidden md:flex opacity-0 group-hover:opacity-100 transition-opacity z-10',
            isDragging && 'cursor-grabbing opacity-100'
          )}
          aria-label="Drag to reorder"
        >
          <GripVertical className="size-3.5" />
        </button>

        {/* Selection Checkbox */}
        {isSelectionMode && onToggleSelect && (
          <div onClick={(e) => e.stopPropagation()}>
            <SelectionCheckbox
              checked={isCheckedForSelection}
              onChange={() => onToggleSelect(task.id)}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              aria-label={`Select ${task.title}`}
            />
          </div>
        )}

        {/* Expand chevron */}
        <ExpandChevron
          isExpanded={isExpanded}
          hasSubtasks={taskHasSubtasks}
          onClick={handleExpandToggle}
          size="sm"
        />

        {/* Task Checkbox */}
        <TaskCheckbox checked={isCompleted} onChange={() => onToggleComplete(task.id)} />

        {/* Title */}
        <span
          className={cn(
            'text-[13px] font-medium leading-4 whitespace-nowrap shrink-0',
            isCompleted ? 'line-through text-muted-foreground' : 'text-foreground'
          )}
        >
          {task.title}
        </span>

        {/* Inline badges */}
        {!isCompleted && (
          <div className="flex items-center gap-[5px] ml-1">
            {task.priority !== 'none' && priorityColor && (
              <span
                className="inline-flex items-center gap-[3px] rounded-[3px] px-1.5 py-px"
                style={{ backgroundColor: `${priorityColor}14`, color: priorityColor }}
              >
                <span
                  className="size-1 rounded-full shrink-0"
                  style={{ backgroundColor: priorityColor }}
                />
                <span className="text-[10px] font-medium leading-3">
                  {priorityConfig[task.priority].label}
                </span>
              </span>
            )}

            {showProjectBadge && (
              <span
                className="inline-flex items-center gap-[3px] rounded-[3px] px-1.5 py-px"
                style={{ backgroundColor: `${project.color}0F`, color: project.color }}
              >
                <span
                  className="size-1 rounded-full shrink-0"
                  style={{ backgroundColor: project.color }}
                />
                <span className="text-[10px] font-medium leading-3">{project.name}</span>
              </span>
            )}
          </div>
        )}

        {/* Repeat indicator */}
        {task.isRepeating && task.repeatConfig && !isCompleted && (
          <RepeatIndicator config={task.repeatConfig} size="sm" />
        )}

        {/* Due date — pushed right */}
        {formattedDate && (
          <span
            className={cn(
              'text-[10px] leading-3 shrink-0 ml-auto',
              isOverdue ? 'text-[#C4654A]' : 'text-muted-foreground'
            )}
          >
            {formattedDate.label}
          </span>
        )}

        {/* Subtask progress bar + fraction */}
        {taskHasSubtasks && (
          <div className={cn('flex items-center gap-[3px] shrink-0', !formattedDate && 'ml-auto')}>
            <div className="w-5 h-[3px] rounded-sm overflow-clip bg-[#EDECE8]">
              <div
                className="h-full rounded-sm bg-[#7B9E87]"
                style={{ width: `${progress.percentage}%` }}
              />
            </div>
            <span className="text-[9px] text-muted-foreground font-mono leading-3">
              {progress.completed}/{progress.total}
            </span>
          </div>
        )}
      </div>

      {/* Subtask list (expanded) */}
      {isExpanded && (
        <SortableSubtaskList
          parentId={task.id}
          parentTitle={task.title}
          subtasks={subtasks}
          onReorder={onReorderSubtasks || (() => {})}
          onToggleComplete={onToggleSubtaskComplete || onToggleComplete}
          onAddSubtask={onAddSubtask}
          onClick={onClick}
        />
      )}
    </div>
  )
}

export default SortableParentTaskRow
