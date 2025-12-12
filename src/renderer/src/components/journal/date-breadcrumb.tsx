/**
 * DateBreadcrumb Component
 * Renders clickable date navigation with pill-style segments
 * Supports day, month, and year view states
 */

import { useMemo } from 'react'
import { ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDateParts, getMonthName } from '@/lib/journal-utils'

// =============================================================================
// TYPES
// =============================================================================

export type JournalViewState =
  | { type: 'day'; date: string }
  | { type: 'month'; year: number; month: number }
  | { type: 'year'; year: number }

export interface DateBreadcrumbProps {
  /** Current view state */
  viewState: JournalViewState
  /** Callback when month is clicked (navigates to month view) */
  onMonthClick: (year: number, month: number) => void
  /** Callback when year is clicked (navigates to year view) */
  onYearClick: (year: number) => void
  /** Callback for back navigation */
  onBackClick: () => void
  /** Additional CSS classes */
  className?: string
}

// =============================================================================
// PILL BUTTON COMPONENT
// =============================================================================

interface PillButtonProps {
  onClick: () => void
  children: React.ReactNode
  className?: string
  isLarge?: boolean
}

function PillButton({ onClick, children, className, isLarge = false }: PillButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // Base pill styling with subtle background to indicate clickability
        "inline-flex items-center rounded-md",
        "bg-surface-active/40",
        "cursor-pointer transition-all duration-150",
        // Text color
        "text-foreground",
        // Hover state - darken background
        "hover:bg-muted-foreground/20",
        // Focus state for accessibility
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        // Active state
        "active:scale-[0.98]",
        // Size-specific padding
        isLarge ? "px-2.5 py-1 -mx-1" : "px-2 py-0.5 -mx-1",
        className
      )}
    >
      {children}
    </button>
  )
}

// =============================================================================
// BACK BUTTON COMPONENT
// =============================================================================

interface BackButtonProps {
  onClick: () => void
  className?: string
}

function BackButton({ onClick, className }: BackButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Go back"
      className={cn(
        "inline-flex items-center gap-1 mr-2",
        "text-muted-foreground hover:text-foreground",
        "cursor-pointer transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-purple/50 focus-visible:rounded-md",
        className
      )}
    >
      <ChevronLeft className="size-5" />
    </button>
  )
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function DateBreadcrumb({
  viewState,
  onMonthClick,
  onYearClick,
  onBackClick,
  className,
}: DateBreadcrumbProps): React.JSX.Element {
  // Parse date parts for day view
  const dateParts = useMemo(() => {
    if (viewState.type === 'day') {
      return formatDateParts(viewState.date)
    }
    return null
  }, [viewState])

  // Day View: "December 12, 2025" with clickable month and year
  if (viewState.type === 'day' && dateParts) {
    return (
      <h1
        className={cn(
          "font-serif text-3xl lg:text-4xl font-medium text-foreground tracking-tight",
          "flex items-center gap-1.5 flex-wrap",
          className
        )}
      >
        <PillButton
          onClick={() => onMonthClick(dateParts.year, dateParts.monthIndex)}
          isLarge
        >
          {dateParts.month}
        </PillButton>
        <span>{dateParts.day},</span>
        <PillButton
          onClick={() => onYearClick(dateParts.year)}
          isLarge
        >
          {dateParts.year}
        </PillButton>
      </h1>
    )
  }

  // Month View: "← December 2025" with back arrow and clickable year
  if (viewState.type === 'month') {
    const monthName = getMonthName(viewState.month)
    return (
      <h1
        className={cn(
          "flex items-center",
          "font-serif text-3xl lg:text-4xl font-medium text-foreground tracking-tight",
          className
        )}
      >
        <BackButton onClick={onBackClick} />
        <span>{monthName}</span>
        <span className="mx-1.5"></span>
        <PillButton
          onClick={() => onYearClick(viewState.year)}
          isLarge
        >
          {viewState.year}
        </PillButton>
      </h1>
    )
  }

  // Year View: "← 2025" with back arrow
  if (viewState.type === 'year') {
    return (
      <h1
        className={cn(
          "flex items-center",
          "font-serif text-3xl lg:text-4xl font-medium text-foreground tracking-tight",
          className
        )}
      >
        <BackButton onClick={onBackClick} />
        <span>{viewState.year}</span>
      </h1>
    )
  }

  return <></>
}

export default DateBreadcrumb
