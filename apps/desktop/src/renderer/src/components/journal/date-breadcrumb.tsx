/**
 * DateBreadcrumb Component
 * Centered navigation breadcrumb for journal page
 * Supports day, month, and year view states with elegant hierarchy
 */

import { useMemo } from 'react'
import { ChevronLeft, ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { formatDateParts, getMonthName, getTodayString } from '@/lib/journal-utils'

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
  /** Callback for day click (for day view - navigates to specific day) */
  onDayClick?: (date: string) => void
  /** Callback for previous day navigation */
  onPreviousDay?: () => void
  /** Callback for next day navigation */
  onNextDay?: () => void
  /** Additional CSS classes */
  className?: string
}

// =============================================================================
// BREADCRUMB SEGMENT COMPONENT
// =============================================================================

interface BreadcrumbSegmentProps {
  onClick?: () => void
  children: React.ReactNode
  isActive?: boolean
  className?: string
}

function BreadcrumbSegment({
  onClick,
  children,
  isActive = false,
  className
}: BreadcrumbSegmentProps) {
  const isClickable = !!onClick

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!isClickable}
      className={cn(
        'inline-flex items-center',
        'font-sans text-sm transition-all duration-200',
        isClickable &&
          !isActive && [
            'text-muted-foreground/70 hover:text-foreground',
            'hover:bg-muted/50 px-2 py-1 -mx-1 rounded-md',
            'cursor-pointer'
          ],
        isActive && 'text-foreground font-medium',
        !isClickable && 'text-muted-foreground/50 cursor-default',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:rounded-md',
        className
      )}
    >
      {children}
    </button>
  )
}

// =============================================================================
// SEPARATOR COMPONENT
// =============================================================================

function BreadcrumbSeparator() {
  return <span className="mx-1 text-muted-foreground/30 select-none">/</span>
}

// =============================================================================
// DAY NAVIGATION ARROWS
// =============================================================================

interface DayNavArrowProps {
  direction: 'prev' | 'next'
  onClick?: () => void
}

function DayNavArrow({ direction, onClick }: DayNavArrowProps) {
  const Icon = direction === 'prev' ? ChevronLeft : ChevronRight

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={direction === 'prev' ? 'Previous day' : 'Next day'}
      className={cn(
        'p-1 rounded-md',
        'text-muted-foreground/50 hover:text-foreground',
        'hover:bg-muted/50',
        'transition-all duration-200',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50'
      )}
    >
      <Icon className="size-3.5" />
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
        'inline-flex items-center gap-1 mr-2 p-1 rounded-md',
        'text-muted-foreground/60 hover:text-foreground',
        'hover:bg-muted/50',
        'cursor-pointer transition-all duration-200',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50',
        className
      )}
    >
      <ChevronLeft className="size-4" />
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
  onPreviousDay,
  onNextDay,
  className
}: DateBreadcrumbProps): React.JSX.Element {
  const today = getTodayString()

  // Parse date parts for day view
  const dateParts = useMemo(() => {
    if (viewState.type === 'day') {
      return formatDateParts(viewState.date)
    }
    return null
  }, [viewState])

  // Check if selected date is today
  const isToday = viewState.type === 'day' && viewState.date === today

  // Day View: Centered breadcrumb with hierarchy
  // [< >] Year / Month / Day DayName [Today]
  if (viewState.type === 'day' && dateParts) {
    return (
      <nav
        aria-label="Journal date navigation"
        className={cn('flex items-center justify-center gap-2', className)}
      >
        {/* Day navigation arrows - grouped on left */}
        <div className="flex items-center gap-0.5 mr-1">
          <DayNavArrow direction="prev" onClick={onPreviousDay} />
          <DayNavArrow direction="next" onClick={onNextDay} />
        </div>

        {/* Breadcrumb segments */}
        <div className="flex items-center">
          {/* Year */}
          <BreadcrumbSegment onClick={() => onYearClick(dateParts.year)}>
            {dateParts.year}
          </BreadcrumbSegment>

          <BreadcrumbSeparator />

          {/* Month */}
          <BreadcrumbSegment onClick={() => onMonthClick(dateParts.year, dateParts.monthIndex)}>
            {dateParts.month}
          </BreadcrumbSegment>

          <BreadcrumbSeparator />

          {/* Day + Day Name (active) */}
          <span className="flex items-center gap-2">
            <span className="font-display text-base font-medium text-foreground">
              {dateParts.day}
            </span>
            <span className="font-serif text-sm italic text-muted-foreground/70">
              {dateParts.dayName}
            </span>
          </span>

          {/* Today badge */}
          {isToday && (
            <span
              className={cn(
                'ml-2.5 px-2 py-0.5',
                'text-[0.6rem] font-semibold uppercase tracking-[0.1em]',
                'bg-amber-500/10 text-amber-700 dark:text-amber-400',
                'rounded-full border border-amber-500/20'
              )}
            >
              Today
            </span>
          )}
        </div>
      </nav>
    )
  }

  // Month View: Back + Month Year with clickable year
  if (viewState.type === 'month') {
    const monthName = getMonthName(viewState.month)
    return (
      <nav
        aria-label="Journal date navigation"
        className={cn('flex items-center justify-center', className)}
      >
        <BackButton onClick={onBackClick} />

        <div className="flex items-center">
          {/* Year (clickable) */}
          <BreadcrumbSegment onClick={() => onYearClick(viewState.year)}>
            {viewState.year}
          </BreadcrumbSegment>

          <BreadcrumbSeparator />

          {/* Month (active) */}
          <span className="font-display text-base font-medium text-foreground">{monthName}</span>
        </div>
      </nav>
    )
  }

  // Year View: Back + Year
  if (viewState.type === 'year') {
    return (
      <nav
        aria-label="Journal date navigation"
        className={cn('flex items-center justify-center', className)}
      >
        <BackButton onClick={onBackClick} />

        <span className="font-display text-base font-medium text-foreground">{viewState.year}</span>
      </nav>
    )
  }

  return <></>
}

export default DateBreadcrumb
