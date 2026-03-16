import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface InsertionIndicatorProps {
  /** Position of the indicator relative to the item */
  position: 'before' | 'after'
  /** Additional class names */
  className?: string
}

// ============================================================================
// INSERTION INDICATOR COMPONENT
// ============================================================================

/**
 * A visual indicator showing where a dragged item will be inserted
 * Displays as a horizontal line with a circle at the start
 */
export const InsertionIndicator = ({
  position,
  className
}: InsertionIndicatorProps): React.JSX.Element => {
  return (
    <div
      className={cn(
        'absolute left-0 right-0 h-0.5 bg-primary pointer-events-none z-20',
        position === 'before' ? '-top-0.5' : '-bottom-0.5',
        className
      )}
      aria-hidden="true"
    >
      {/* Circle at the start of the line */}
      <div className={cn('absolute -left-1 w-2 h-2 bg-primary rounded-full', '-top-[3px]')} />
    </div>
  )
}

// ============================================================================
// DROP LINE INDICATOR
// ============================================================================

interface DropLineIndicatorProps {
  /** Whether the indicator is visible */
  isVisible: boolean
  /** Additional class names */
  className?: string
}

/**
 * A full-width drop line indicator for sections
 */
export const DropLineIndicator = ({
  isVisible,
  className
}: DropLineIndicatorProps): React.JSX.Element => {
  if (!isVisible) return <></>

  return (
    <div
      className={cn(
        'h-0.5 bg-primary rounded-full mx-2 my-1 transition-opacity',
        isVisible ? 'opacity-100' : 'opacity-0',
        className
      )}
      aria-hidden="true"
    />
  )
}

// ============================================================================
// COLUMN DROP INDICATOR (for Kanban)
// ============================================================================

interface ColumnDropIndicatorProps {
  /** Label to show in the drop zone */
  label?: string
  /** Additional class names */
  className?: string
}

/**
 * A visual indicator for dropping into a Kanban column
 */
export const ColumnDropIndicator = ({
  label = 'Drop here',
  className
}: ColumnDropIndicatorProps): React.JSX.Element => {
  return (
    <div
      className={cn(
        'flex items-center justify-center',
        'm-2 p-4 border-2 border-dashed border-primary/50 rounded-sm',
        'bg-primary/5 text-primary text-sm font-medium',
        'transition-all duration-200',
        className
      )}
    >
      {label}
    </div>
  )
}

// ============================================================================
// DATE CELL DROP INDICATOR (for Calendar)
// ============================================================================

interface DateDropIndicatorProps {
  /** Date label to show */
  dateLabel: string
  /** Additional class names */
  className?: string
}

/**
 * A visual indicator for dropping onto a calendar date
 */
export const DateDropIndicator = ({
  dateLabel,
  className
}: DateDropIndicatorProps): React.JSX.Element => {
  return (
    <div
      className={cn(
        'absolute inset-0 flex items-center justify-center',
        'bg-primary/10 border-2 border-primary rounded-sm',
        'pointer-events-none z-10',
        className
      )}
    >
      <span className="text-xs font-medium text-primary px-2 py-1 bg-background rounded shadow-sm">
        Drop to reschedule to {dateLabel}
      </span>
    </div>
  )
}

// ============================================================================
// INVALID DROP INDICATOR
// ============================================================================

interface InvalidDropIndicatorProps {
  /** Message to show */
  message?: string
  /** Additional class names */
  className?: string
}

/**
 * An indicator showing an invalid drop target
 */
export const InvalidDropIndicator = ({
  message = 'Cannot drop here',
  className
}: InvalidDropIndicatorProps): React.JSX.Element => {
  return (
    <div
      className={cn(
        'absolute inset-0 flex flex-col items-center justify-center gap-1',
        'bg-destructive/10 border-2 border-destructive/50 rounded-sm',
        'pointer-events-none z-10',
        className
      )}
    >
      <span className="text-lg text-destructive">✕</span>
      <span className="text-xs font-medium text-destructive">{message}</span>
    </div>
  )
}

export default InsertionIndicator
