import { useRef, useEffect, useState, memo } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'

import { cn } from '@/lib/utils'
import { formatDueDate, getDaysOverdue, getOverdueTier, overdueTierStyles } from '@/lib/task-utils'
import {
  TaskCheckbox,
  ProjectBadge,
  PriorityBadge,
  InteractiveProjectBadge,
  InteractivePriorityBadge,
  InteractiveDueDateBadge
} from '@/components/tasks/task-badges'
import { RepeatIndicator } from '@/components/tasks/repeat-indicator'
import { SelectionCheckbox } from '@/components/tasks/bulk-actions'

import type { Task, Priority } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface SortableTaskRowProps {
  task: Task
  project: Project
  projects: Project[]
  sectionId: string
  allTasks?: Task[]
  isCompleted: boolean
  isSelected?: boolean
  showProjectBadge?: boolean
  onToggleComplete: (taskId: string) => void
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onClick?: (taskId: string) => void
  className?: string
  /** Whether selection mode is active */
  isSelectionMode?: boolean
  /** Whether this specific task is checked for selection */
  isCheckedForSelection?: boolean
  /** Toggle selection for this task */
  onToggleSelect?: (taskId: string) => void
  /** Handle shift+click for range selection */
  onShiftSelect?: (taskId: string) => void
  /** Optional accent class for urgency styling (e.g., left border) */
  accentClass?: string
}

// Exit animation duration in ms (matches --duration-normal CSS variable)
const EXIT_ANIMATION_DURATION = 200

// ============================================================================
// PROP COMPARISON FOR MEMOIZATION
// ============================================================================

/**
 * Custom comparison function for React.memo
 * Only re-render when task data or visual state changes
 */
const arePropsEqual = (
  prevProps: SortableTaskRowProps,
  nextProps: SortableTaskRowProps
): boolean => {
  // Task identity and content
  if (prevProps.task.id !== nextProps.task.id) return false
  if (prevProps.task.title !== nextProps.task.title) return false
  if (prevProps.task.priority !== nextProps.task.priority) return false
  if (prevProps.task.statusId !== nextProps.task.statusId) return false
  if (prevProps.task.isRepeating !== nextProps.task.isRepeating) return false

  // Date comparison (handle null case)
  const prevDate = prevProps.task.dueDate?.getTime() ?? null
  const nextDate = nextProps.task.dueDate?.getTime() ?? null
  if (prevDate !== nextDate) return false

  // Time comparison
  if (prevProps.task.dueTime !== nextProps.task.dueTime) return false

  // Visual state
  if (prevProps.isCompleted !== nextProps.isCompleted) return false
  if (prevProps.isSelected !== nextProps.isSelected) return false
  if (prevProps.isSelectionMode !== nextProps.isSelectionMode) return false
  if (prevProps.isCheckedForSelection !== nextProps.isCheckedForSelection) return false
  if (prevProps.showProjectBadge !== nextProps.showProjectBadge) return false
  if (prevProps.accentClass !== nextProps.accentClass) return false

  // Project reference (compare by id for performance)
  if (prevProps.project.id !== nextProps.project.id) return false

  // Section (for drag context)
  if (prevProps.sectionId !== nextProps.sectionId) return false

  return true
}

// ============================================================================
// SORTABLE TASK ROW COMPONENT
// ============================================================================

const SortableTaskRowComponent = ({
  task,
  project,
  projects,
  sectionId,
  allTasks: _allTasks,
  isCompleted,
  isSelected = false,
  showProjectBadge = false,
  onToggleComplete,
  onUpdateTask,
  onClick,
  className,
  isSelectionMode = false,
  isCheckedForSelection = false,
  onToggleSelect,
  onShiftSelect,
  accentClass
}: SortableTaskRowProps): React.JSX.Element => {
  const rowRef = useRef<HTMLDivElement>(null)
  const [isExiting, setIsExiting] = useState(false)

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: {
      type: 'task',
      task,
      sectionId,
      sourceType: 'list'
    }
  })

  // Scroll into view when focused via keyboard navigation
  useEffect(() => {
    if (isSelected && rowRef.current) {
      rowRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest'
      })
    }
  }, [isSelected])

  // Combine refs
  const setRefs = (node: HTMLDivElement | null): void => {
    setNodeRef(node)
    ;(rowRef as React.MutableRefObject<HTMLDivElement | null>).current = node
  }

  // Apply transform and transition styles
  // When exiting, animate opacity+scale only (no height collapse).
  // Height collapse via max-height breaks virtualized lists where items are
  // position:absolute — the virtualizer remeasures mid-animation and repositions
  // siblings into the still-visible exiting item, causing overlap.
  const style: React.CSSProperties = isExiting
    ? {
        opacity: 0,
        transform: 'scale(0.98)',
        transition: 'opacity 200ms ease-out, transform 200ms ease-out',
        pointerEvents: 'none'
      }
    : {
        transform: CSS.Transform.toString(transform),
        transition: transition || 'transform 200ms ease-out'
      }

  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const isOverdue = formattedDate?.status === 'overdue'
  const daysOver = isOverdue && !isCompleted ? getDaysOverdue(task.dueDate) : 0
  const overdueTier = daysOver > 0 ? getOverdueTier(daysOver) : null
  const tierRowStyle = overdueTier ? overdueTierStyles[overdueTier].rowBg : null

  const handleRowClick = (e: React.MouseEvent): void => {
    // Don't trigger if clicking on drag handle
    if ((e.target as HTMLElement).closest('[data-drag-handle]')) {
      return
    }

    // Shift+click for range selection
    if (e.shiftKey && isSelectionMode && onShiftSelect) {
      e.preventDefault()
      onShiftSelect(task.id)
      return
    }

    // Cmd/Ctrl+click for toggle selection
    if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
      e.preventDefault()
      onToggleSelect(task.id)
      return
    }

    // In selection mode, clicking toggles selection
    if (isSelectionMode && onToggleSelect) {
      onToggleSelect(task.id)
      return
    }

    // Normal click behavior
    onClick?.(task.id)
  }

  const handleRowKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && onClick) {
      e.preventDefault()
      onClick(task.id)
    }
  }

  const handleToggleComplete = (): void => {
    // If task is not completed (about to be completed), play exit animation
    if (!isCompleted) {
      setIsExiting(true)
      // Delay the actual toggle to allow animation to play
      setTimeout(() => {
        onToggleComplete(task.id)
      }, EXIT_ANIMATION_DURATION)
    } else {
      // If unchecking, no animation needed
      onToggleComplete(task.id)
    }
  }

  const handleSelectionCheckboxChange = (): void => {
    onToggleSelect?.(task.id)
  }

  const handleSelectionCheckboxClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
  }

  const handleProjectChange = (projectId: string): void => {
    onUpdateTask?.(task.id, { projectId })
  }

  const handlePriorityChange = (priority: Priority): void => {
    onUpdateTask?.(task.id, { priority })
  }

  const handleDateChange = (date: Date | null): void => {
    onUpdateTask?.(task.id, { dueDate: date })
  }

  // Determine grid columns based on what's shown
  // Base: [drag][select?][check][title][project?][priority][due]
  const showSelection = !!onToggleSelect

  return (
    <div
      ref={setRefs}
      style={style}
      role="button"
      tabIndex={onClick ? 0 : -1}
      onClick={handleRowClick}
      onKeyDown={onClick ? handleRowKeyDown : undefined}
      className={cn(
        'group rounded-md px-2 py-2.5 transition-all duration-150',
        'hover:bg-accent/50',
        onClick &&
          'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        // Mobile: flex layout for stacked view
        'flex flex-col gap-1',
        // Tablet+: grid layout with fixed columns
        // When selection mode is active: [drag][select][check][title][project?][priority][due]
        // When selection mode is inactive: [drag][check][title][project?][priority][due]
        'md:grid md:items-center md:gap-1',
        // Dynamic grid columns based on selection mode
        // [drag 24px][select? 20px][check 20px][chevron 20px][title 1fr][project? 120px][priority 70px][due 110px]
        isSelectionMode
          ? showProjectBadge
            ? 'md:grid-cols-[24px_20px_20px_20px_1fr_70px_110px] lg:grid-cols-[24px_20px_20px_20px_1fr_120px_70px_110px]'
            : 'md:grid-cols-[24px_20px_20px_20px_1fr_70px_110px]'
          : showProjectBadge
            ? 'md:grid-cols-[24px_20px_20px_1fr_70px_110px] lg:grid-cols-[24px_20px_20px_1fr_120px_70px_110px]'
            : 'md:grid-cols-[24px_20px_20px_1fr_70px_110px]',
        tierRowStyle,
        overdueTier === 'severe' && 'overdue-pulse',
        // Selection highlight (when checked for selection)
        isCheckedForSelection && 'bg-primary/10 hover:bg-primary/15',
        // Detail panel selected (not the same as selection mode)
        isSelected && !isCheckedForSelection && 'bg-primary/10 ring-2 ring-primary/30',
        // Dragging state
        isDragging && 'opacity-50 shadow-lg ring-2 ring-primary bg-background z-10',
        isExiting && 'select-none',
        className
      )}
      aria-label={`Task: ${task.title}${isCompleted ? ', completed' : ''}`}
    >
      {/* Mobile: Main row with checkbox and title */}
      {/* Desktop: Grid columns */}
      <div className="flex items-center gap-2 md:contents">
        {/* Drag Handle - Column 1 */}
        <button
          type="button"
          data-drag-handle
          {...attributes}
          {...listeners}
          className={cn(
            'flex items-center justify-center cursor-grab touch-none text-muted-foreground/50',
            'hover:text-muted-foreground active:cursor-grabbing',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded',
            'opacity-0 group-hover:opacity-100 transition-opacity',
            // Hide on mobile
            'hidden md:flex',
            isDragging && 'cursor-grabbing opacity-100'
          )}
          aria-label="Drag to reorder"
        >
          <GripVertical className="size-4" />
        </button>

        {/* Selection Checkbox - Column 2 (only rendered in selection mode) */}
        {isSelectionMode && (
          <div className="hidden md:flex items-center justify-center">
            {showSelection && (
              <SelectionCheckbox
                checked={isCheckedForSelection}
                onChange={handleSelectionCheckboxChange}
                onClick={handleSelectionCheckboxClick}
                aria-label={`Select ${task.title}`}
              />
            )}
          </div>
        )}

        {/* Task Completion Checkbox - Column 3 (20px) */}
        {/* Disabled during selection mode to prevent accidental completions */}
        <div className="flex items-center justify-center shrink-0">
          <TaskCheckbox
            checked={isCompleted}
            onChange={handleToggleComplete}
            disabled={isSelectionMode}
          />
        </div>

        {/* Chevron Placeholder - Column 4 (20px) - empty for non-parent tasks */}
        <div className="hidden md:block w-5" aria-hidden="true" />

        {/* Title with Repeat Indicator and Subtask Progress - Column 5 (flex-1) */}
        <div className="flex flex-1 items-center gap-2 min-w-0">
          <span
            className={cn(
              'truncate text-sm',
              // Show strikethrough immediately when exiting (completing) or when already completed
              isExiting || isCompleted
                ? 'text-text-tertiary line-through decoration-text-tertiary'
                : 'text-text-primary'
            )}
          >
            {task.title}
          </span>
          {task.isRepeating && task.repeatConfig && !isCompleted && (
            <RepeatIndicator config={task.repeatConfig} size="sm" />
          )}
        </div>

        {/* Project Badge - Column 5 (conditional, 120px) - hidden on mobile & tablet */}
        {showProjectBadge && (
          <div className="hidden lg:block">
            <InteractiveProjectBadge
              project={project}
              projects={projects}
              onProjectChange={handleProjectChange}
              fixedWidth
            />
          </div>
        )}

        {/* Priority Badge - Column 6 (70px) - hidden on mobile */}
        <div className="hidden md:block">
          <InteractivePriorityBadge
            priority={isCompleted ? 'none' : task.priority}
            onPriorityChange={handlePriorityChange}
            compact
            fixedWidth
          />
        </div>

        {/* Due Date Badge - Column 7 (110px) - hidden on mobile */}
        <div className="hidden md:block">
          <InteractiveDueDateBadge
            dueDate={task.dueDate}
            dueTime={task.dueTime}
            onDateChange={handleDateChange}
            isRepeating={task.isRepeating}
            fixedWidth
            className={cn(isCompleted && 'opacity-60')}
          />
        </div>
      </div>

      {/* Mobile: Stacked metadata row */}
      <div className="flex items-center gap-2 pl-7 text-xs md:hidden">
        {showProjectBadge && (
          <InteractiveProjectBadge
            project={project}
            projects={projects}
            onProjectChange={handleProjectChange}
          />
        )}
        {!isCompleted && task.priority !== 'none' && (
          <InteractivePriorityBadge
            priority={task.priority}
            onPriorityChange={handlePriorityChange}
            compact
          />
        )}
        <InteractiveDueDateBadge
          dueDate={task.dueDate}
          dueTime={task.dueTime}
          onDateChange={handleDateChange}
          isRepeating={task.isRepeating}
          className={cn(isCompleted && 'opacity-60')}
        />
      </div>
    </div>
  )
}

// Memoized export to prevent unnecessary re-renders
export const SortableTaskRow = memo(SortableTaskRowComponent, arePropsEqual)

// ============================================================================
// DRAG PREVIEW (for overlay)
// ============================================================================

interface TaskRowPreviewProps {
  task: Task
  project?: Project
  isCompleted?: boolean
}

export const TaskRowPreview = ({
  task,
  project,
  isCompleted = false
}: TaskRowPreviewProps): React.JSX.Element => {
  const formattedDate = formatDueDate(task.dueDate, task.dueTime)
  const isOverdue = formattedDate?.status === 'overdue' && !isCompleted

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border bg-card p-3 shadow-xl',
        'rotate-2 scale-105',
        isOverdue && 'bg-rose-50/60 dark:bg-rose-950/20'
      )}
      style={{ width: '320px' }}
    >
      <TaskCheckbox checked={isCompleted} onChange={() => {}} />

      <div className="flex flex-1 items-center gap-2 min-w-0">
        <span
          className={cn(
            'truncate text-sm font-medium',
            isCompleted && 'text-muted-foreground line-through'
          )}
        >
          {task.title}
        </span>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {project && <ProjectBadge project={project} />}
        {!isCompleted && <PriorityBadge priority={task.priority} />}
      </div>
    </div>
  )
}

export default SortableTaskRow

// Re-export the component type for reference
export type { SortableTaskRowProps }
