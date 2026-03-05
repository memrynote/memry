import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'

import { cn } from '@/lib/utils'
import { useDragContext } from '@/contexts/drag-context'
import type { Task } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

interface DroppableSectionProps {
  /** Unique section ID */
  sectionId: string
  /** Display label for the section */
  label: string
  /** Date associated with this section (for reschedule) */
  date?: Date
  /** Tasks in this section */
  tasks: Task[]
  /** Children to render inside the section */
  children: React.ReactNode
  /** Additional class names */
  className?: string
  /** Variant for styling */
  variant?: 'default' | 'overdue' | 'today' | 'upcoming'
}

// ============================================================================
// DROPPABLE SECTION COMPONENT
// ============================================================================

export const DroppableSection = ({
  sectionId,
  label,
  date,
  tasks,
  children,
  className,
  variant = 'default'
}: DroppableSectionProps): React.JSX.Element => {
  const { dragState } = useDragContext()

  const { setNodeRef, isOver } = useDroppable({
    id: `section-${sectionId}`,
    data: {
      type: 'section',
      sectionId,
      label,
      date
    }
  })

  // Check if we're dragging from a different section
  const isDraggingFromOtherSection =
    dragState.isDragging && dragState.sourceContainerId !== sectionId

  // Get task IDs for SortableContext
  const taskIds = tasks.map((t) => t.id)

  // Styling based on variant
  const variantStyles = {
    default: {
      accent: 'border-l-border',
      bg: 'bg-background',
      hoverBg: 'bg-accent/20'
    },
    overdue: {
      accent: 'border-l-border',
      bg: 'bg-background',
      hoverBg: 'bg-accent/20'
    },
    today: {
      accent: 'border-l-amber-500',
      bg: 'bg-amber-50/30 dark:bg-amber-950/10',
      hoverBg: 'bg-amber-100/50 dark:bg-amber-950/30'
    },
    upcoming: {
      accent: 'border-l-blue-500',
      bg: 'bg-blue-50/30 dark:bg-blue-950/10',
      hoverBg: 'bg-blue-100/50 dark:bg-blue-950/30'
    }
  }

  const styles = variantStyles[variant]

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'rounded-lg border border-border overflow-hidden transition-all duration-200',
        'border-l-2',
        styles.accent,
        styles.bg,
        // Drop zone active state
        isOver && 'border-dotted border-primary/60',
        isOver && styles.hoverBg,
        // Show as potential drop target when dragging
        isDraggingFromOtherSection && !isOver && 'border-dotted border-muted-foreground/40',
        className
      )}
    >
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>

      {/* Drop indicator message when hovering */}
      {isOver && isDraggingFromOtherSection && (
        <div className="px-4 py-2 text-center text-sm text-primary font-medium bg-primary/5 border-t border-primary/20">
          {date ? <>Drop to reschedule to {label}</> : <>Drop to move to {label}</>}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// SECTION HEADER COMPONENT
// ============================================================================

interface DroppableSectionHeaderProps {
  title: string
  subtitle?: string
  count: number
  variant?: 'default' | 'overdue' | 'today' | 'upcoming'
}

export const DroppableSectionHeader = ({
  title,
  subtitle,
  count,
  variant = 'default'
}: DroppableSectionHeaderProps): React.JSX.Element => {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/50">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'font-semibold text-sm uppercase tracking-wide',
            variant === 'overdue' && 'text-red-600 dark:text-red-400',
            variant === 'today' && 'text-amber-600 dark:text-amber-500',
            variant === 'upcoming' && 'text-blue-600 dark:text-blue-400',
            variant === 'default' && 'text-text-secondary'
          )}
        >
          {title}
        </span>
        {subtitle && <span className="text-sm text-text-tertiary">· {subtitle}</span>}
      </div>

      <span
        className={cn(
          'text-xs px-2 py-0.5 rounded-full font-medium',
          variant === 'overdue' && 'bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-400',
          variant === 'today' &&
            'bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-500',
          variant === 'upcoming' &&
            'bg-blue-100 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400',
          variant === 'default' && 'bg-muted text-text-tertiary'
        )}
      >
        {count}
      </span>
    </div>
  )
}

// ============================================================================
// EMPTY DROP ZONE
// ============================================================================

interface EmptyDropZoneProps {
  isOver: boolean
  label?: string
}

export const EmptyDropZone = ({
  isOver,
  label = 'Drop task here'
}: EmptyDropZoneProps): React.JSX.Element => {
  return (
    <div
      className={cn(
        'flex items-center justify-center py-8 border-2 border-dashed rounded-lg mx-2 my-2 transition-colors',
        isOver
          ? 'border-primary/50 bg-primary/5 text-primary'
          : 'border-muted-foreground/20 text-muted-foreground'
      )}
    >
      <span className="text-sm">{label}</span>
    </div>
  )
}

export default DroppableSection
