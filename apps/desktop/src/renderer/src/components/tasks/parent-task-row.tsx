import { useEffect, useRef } from 'react'

import { ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { hasSubtasks, type SubtaskProgress } from '@/lib/subtask-utils'
import { formatDateShort, formatDueDate, formatTime } from '@/lib/task-utils'
import { SelectionCheckbox } from '@/components/tasks/bulk-actions'
import { ExpandChevron } from '@/components/tasks/expand-chevron'
import { InsertionIndicator } from '@/components/tasks/drag-drop/insertion-indicator'
import type { SectionDragState } from '@/components/tasks/drag-drop/list-section-drag-state'
import { RepeatIndicator } from '@/components/tasks/repeat-indicator'
import { SortableSubtaskList } from '@/components/tasks/sortable-subtask-list'
import { StatusIcon } from '@/components/tasks/status-icon'
import { InlineStatusPopover } from '@/components/tasks/inline-status-popover'
import { InlinePriorityPopover } from '@/components/tasks/inline-priority-popover'
import { SubtaskProgressIndicator } from '@/components/tasks/subtask-progress-indicator'
import { PriorityBars } from '@/components/tasks/task-icons'
import type { Priority, Task } from '@/data/sample-tasks'
import type { Project, Status } from '@/data/tasks-data'

export interface ParentTaskRowProps {
  task: Task
  project: Project
  projects?: Project[]
  subtasks: Task[]
  progress: SubtaskProgress
  isExpanded: boolean
  isCompleted: boolean
  isSelected?: boolean
  showProjectBadge?: boolean
  onToggleExpand: (taskId: string) => void
  onToggleComplete: (taskId: string) => void
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
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
  isDragging?: boolean
  isJustDropped?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dragHandleListeners?: Record<string, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dragHandleAttributes?: Record<string, any>
  droppedPriority?: Priority | null
  insertionIndicatorPosition?: 'before' | 'after'
  sectionDragState?: SectionDragState
  renderMode?: 'live' | 'overlay'
  dataTestId?: string
  overlayWidth?: number | null
}

const PRIORITY_LABELS: Record<string, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'None'
}

const resolveStatus = (
  task: Task,
  statuses: Status[]
): { type: 'todo' | 'in_progress' | 'done'; color: string } => {
  const status = statuses.find((s) => s.id === task.statusId)
  return {
    type: (status?.type as 'todo' | 'in_progress' | 'done') || 'todo',
    color: status?.color || 'var(--text-tertiary)'
  }
}

export const ParentTaskRow = ({
  task,
  project,
  projects: _projects = [],
  subtasks,
  progress,
  isExpanded,
  isCompleted,
  isSelected = false,
  showProjectBadge = false,
  onToggleExpand,
  onToggleComplete,
  onUpdateTask,
  onToggleSubtaskComplete,
  onClick,
  className,
  isSelectionMode = false,
  isCheckedForSelection = false,
  onToggleSelect,
  onShiftSelect,
  onAddSubtask: _onAddSubtask,
  onReorderSubtasks,
  accentClass: _accentClass,
  isDragging = false,
  isJustDropped = false,
  dragHandleListeners,
  dragHandleAttributes,
  droppedPriority,
  insertionIndicatorPosition,
  sectionDragState = 'none',
  renderMode = 'live',
  dataTestId,
  overlayWidth
}: ParentTaskRowProps): React.JSX.Element => {
  const isOverlay = renderMode === 'overlay'
  const rowRef = useRef<HTMLDivElement>(null)
  const taskHasSubtasks = hasSubtasks(task)
  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const isOverdue = formattedDate?.status === 'overdue' && !isCompleted
  const { type: statusType, color: statusColor } = resolveStatus(task, project.statuses)

  useEffect(() => {
    if (isSelected && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [isSelected])

  const handleRowClick = (e: React.MouseEvent): void => {
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

  const compactDateLabel = (() => {
    if (!task.dueDate) return null
    const date = formatDateShort(task.dueDate)
    return task.dueTime ? `${date}, ${formatTime(task.dueTime)}` : date
  })()

  const dueDateDisplay = (() => {
    if (isCompleted) return { text: 'Done', colorStyle: statusColor }
    if (!compactDateLabel) return null
    if (isOverdue) return { text: compactDateLabel, colorClass: 'text-destructive' }
    return { text: compactDateLabel, colorClass: 'text-text-tertiary' }
  })()

  const compactDateLabel = (() => {
    if (!task.dueDate) return null
    const date = formatDateShort(task.dueDate)
    return task.dueTime ? `${date}, ${formatTime(task.dueTime)}` : date
  })()

  const dueDateDisplay = (() => {
    if (isCompleted) return { text: 'Done', colorStyle: statusColor }
    if (!compactDateLabel) return null
    if (isOverdue) return { text: compactDateLabel, colorClass: 'text-destructive' }
    return { text: compactDateLabel, colorClass: 'text-text-tertiary' }
  })()

  return (
    <div className={cn('group relative', className)}>
      <div
        ref={rowRef}
        style={isOverlay && overlayWidth ? { width: `${overlayWidth}px` } : undefined}
        role={isOverlay ? undefined : 'button'}
        tabIndex={isOverlay ? undefined : onClick ? 0 : -1}
        onClick={isOverlay ? undefined : handleRowClick}
        onKeyDown={isOverlay ? undefined : onClick ? handleRowKeyDown : undefined}
        {...(isOverlay ? {} : dragHandleAttributes)}
        {...(isOverlay ? {} : dragHandleListeners)}
        className={cn(
          isOverlay
            ? [
                'relative flex w-full items-center gap-2 rounded-md bg-card px-3 py-[7px]',
                'border-[1.5px] border-[#4C9EFF] cursor-grabbing select-none',
                '[box-shadow:rgba(0,0,0,0.5)_0px_8px_24px,rgba(76,158,255,0.15)_0px_2px_8px]'
              ]
            : [
                'relative flex items-center py-[7px] px-3 gap-3 transition-colors',
                'rounded-md hover:bg-accent/60',
                onClick &&
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                dragHandleListeners && !isDragging && 'cursor-grab',
                isDragging &&
                  'cursor-grabbing opacity-[0.35] border-dashed border-primary/30 bg-primary/[0.03]',
                !isDragging && !dragHandleListeners && onClick && 'cursor-pointer',
                isCheckedForSelection && 'bg-primary/10 hover:bg-primary/15',
                isSelected &&
                  !isCheckedForSelection &&
                  'bg-primary/10 ring-1 ring-inset ring-primary/30',
                sectionDragState === 'source-dimmed' && 'opacity-50',
                sectionDragState === 'target-highlighted' && 'bg-primary/[0.04]',
                insertionIndicatorPosition === 'before' && 'pt-1',
                insertionIndicatorPosition === 'after' && 'pb-1',
                !isDragging && isJustDropped && 'animate-row-drop-flash'
              ]
        )}
        data-section-drag-state={sectionDragState}
        data-overlay-row-variant={isOverlay ? 'parent' : undefined}
        data-testid={dataTestId}
        aria-hidden={isOverlay ? true : undefined}
        aria-label={
          isOverlay
            ? undefined
            : `Task: ${task.title}${isCompleted ? ', completed' : ''}${taskHasSubtasks ? `, ${subtasks.length} subtasks` : ''}`
        }
      >
        {!isOverlay && insertionIndicatorPosition && (
          <InsertionIndicator
            position={insertionIndicatorPosition}
            className="left-3 right-3"
            dataTestId="list-drop-indicator"
          />
        )}

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

        {isOverlay ? (
          taskHasSubtasks ? (
            <div
              className="flex items-center justify-center shrink-0 text-text-tertiary"
              aria-label={isExpanded ? 'Collapse subtasks' : 'Expand subtasks'}
            >
              <ChevronDown
                size={10}
                className={cn(
                  'transition-transform duration-200 ease-out',
                  !isExpanded && '-rotate-90'
                )}
              />
            </div>
          ) : (
            <div className="shrink-0 w-[10px] h-[10px]" aria-hidden="true" />
          )
        ) : (
          <ExpandChevron
            isExpanded={isExpanded}
            hasSubtasks={taskHasSubtasks}
            onClick={handleExpandToggle}
            size="sm"
          />
        )}

        {isOverlay ? (
          <StatusIcon type={isCompleted ? 'done' : statusType} color={statusColor} size="lg" />
        ) : (
          <InlineStatusPopover
            statusId={task.statusId}
            statuses={project.statuses}
            isCompleted={isCompleted}
            onStatusChange={(statusId) => onUpdateTask?.(task.id, { statusId })}
            onToggleComplete={() => onToggleComplete(task.id)}
            disabled={isDragging}
          />
        )}

        {isOverlay ? (
          <PriorityBars priority={task.priority} />
        ) : (
          <InlinePriorityPopover
            priority={task.priority}
            onPriorityChange={(priority) => onUpdateTask?.(task.id, { priority })}
            disabled={isDragging}
          />
        )}

        <span
          className={cn(
            'text-[13px] leading-4 grow shrink basis-0 truncate',
            isCompleted
              ? isOverlay
                ? 'text-text-tertiary line-through decoration-1 [text-underline-position:from-font]'
                : 'text-text-tertiary line-through decoration-1 [text-underline-position:from-font]'
              : isOverlay
                ? 'text-card-foreground font-medium'
                : 'text-text-primary'
          )}
        >
          {task.title}
        </span>

        {taskHasSubtasks && (
          <SubtaskProgressIndicator
            completed={progress.completed}
            total={progress.total}
            accentColor={statusColor}
          />
        )}

        {task.isRepeating && task.repeatConfig && (
          <RepeatIndicator config={task.repeatConfig} size="sm" showTooltip={!isOverlay} />
        )}

        {showProjectBadge && (
          <div className="flex items-center shrink-0 gap-[5px]">
            <div
              className="rounded-xs shrink-0 size-2"
              style={{ backgroundColor: project.color }}
            />
            <div
              className={cn('text-[11px] leading-3.5 truncate max-w-[100px]', 'text-text-tertiary')}
            >
              {project.name}
            </div>
          </div>
        )}

        {dueDateDisplay && (
          <div
            className={cn(
              'text-[11px] shrink-0 text-right leading-3.5 whitespace-nowrap',
              'colorClass' in dueDateDisplay
                ? dueDateDisplay.colorClass
                : isOverlay
                  ? 'text-text-tertiary'
                  : null
            )}
            style={
              'colorStyle' in dueDateDisplay ? { color: dueDateDisplay.colorStyle } : undefined
            }
          >
            {dueDateDisplay.text}
          </div>
        )}

        {!isOverlay && droppedPriority && (
          <div className="flex items-center shrink-0 gap-1 px-2 py-0.5 bg-primary/10 rounded text-[10px] font-medium text-primary animate-fade-out">
            priority: {PRIORITY_LABELS[droppedPriority] ?? droppedPriority}
          </div>
        )}
      </div>

      {!isOverlay && isExpanded && (
        <SortableSubtaskList
          parentId={task.id}
          parentTitle={task.title}
          subtasks={subtasks}
          statuses={project.statuses}
          onReorder={onReorderSubtasks || (() => {})}
          onToggleComplete={onToggleSubtaskComplete || onToggleComplete}
          onClick={onClick}
        />
      )}
    </div>
  )
}

export default ParentTaskRow
