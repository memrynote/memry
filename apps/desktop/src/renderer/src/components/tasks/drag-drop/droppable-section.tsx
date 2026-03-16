import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'

import { cn } from '@/lib/utils'
import { SectionDivider, type SectionDividerVariant } from '@/components/tasks/section-divider'
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
      accent: 'border-l-task-due-today',
      bg: 'bg-task-due-today/[0.06]',
      hoverBg: 'bg-task-due-today/[0.12]'
    },
    upcoming: {
      accent: 'border-l-task-due-tomorrow',
      bg: 'bg-task-due-tomorrow/[0.06]',
      hoverBg: 'bg-task-due-tomorrow/[0.12]'
    }
  }

  const styles = variantStyles[variant]

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'rounded-sm border border-border overflow-hidden transition-all duration-200',
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
  const dividerVariant: SectionDividerVariant = variant === 'overdue' ? 'overdue' : 'default'
  const label = subtitle ? `${title} · ${subtitle}` : title

  return <SectionDivider label={label} count={count} variant={dividerVariant} className="px-4" />
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
        'flex items-center justify-center py-8 border-2 border-dashed rounded-sm mx-2 my-2 transition-colors',
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
