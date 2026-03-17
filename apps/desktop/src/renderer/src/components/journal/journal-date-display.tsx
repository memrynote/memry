/**
 * JournalDateDisplay Component
 * Large editorial date display with time-of-day greeting and gradient background
 * Adapts to day, month, and year views
 */

import { useMemo } from 'react'
import { Sun, Sunset, Moon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { getMonthName } from '@/lib/journal-utils'
import type { JournalViewState } from './date-breadcrumb'

// =============================================================================
// TYPES
// =============================================================================

export type TimeOfDay = 'morning' | 'afternoon' | 'evening'

export interface DateParts {
  day: number
  month: string
  monthIndex: number
  year: number
  dayName: string
}

export interface JournalDateDisplayProps {
  /** Current view state */
  viewState: JournalViewState
  /** Parsed date parts for display (only needed for day view) */
  dateParts: DateParts | null
  /** Whether currently viewing today's date */
  isToday: boolean
  /** Layout variant */
  variant?: 'card' | 'flush' | 'compact'
  /** Whether the view is in compact mode (centers content) */
  isCompact?: boolean
  /** Optional navigation or actions to render inside the header */
  children?: React.ReactNode
  /** Additional CSS classes */
  className?: string
}

// =============================================================================
// TIME OF DAY CONFIG
// =============================================================================

const timeOfDayConfig = {
  morning: {
    icon: Sun,
    label: 'Morning',
    gradient: 'from-amber-100/50 to-orange-50/30',
    darkGradient: 'dark:from-amber-950/30 dark:to-orange-950/20',
    iconColor: 'text-amber-500',
    labelColor: 'text-amber-800/80 dark:text-amber-200/80'
  },
  afternoon: {
    icon: Sunset,
    label: 'Afternoon',
    gradient: 'from-orange-100/50 to-rose-50/30',
    darkGradient: 'dark:from-orange-950/30 dark:to-rose-950/20',
    iconColor: 'text-orange-500',
    labelColor: 'text-orange-800/80 dark:text-orange-200/80'
  },
  evening: {
    icon: Moon,
    label: 'Evening',
    gradient: 'from-indigo-100/50 to-purple-50/30',
    darkGradient: 'dark:from-indigo-950/30 dark:to-purple-950/20',
    iconColor: 'text-indigo-500',
    labelColor: 'text-indigo-800/80 dark:text-indigo-200/80'
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function getTimeOfDay(): TimeOfDay {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  return 'evening'
}

// =============================================================================
// GREETING COMPONENT
// =============================================================================

interface GreetingProps {
  timeOfDay: TimeOfDay
  className?: string
}

function Greeting({ timeOfDay, className }: GreetingProps) {
  const config = timeOfDayConfig[timeOfDay]
  const Icon = config.icon

  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <Icon className={cn('size-5', config.iconColor)} />
      <span className={cn('text-base font-medium', config.labelColor)}>{config.label}</span>
    </div>
  )
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function JournalDateDisplay({
  viewState,
  dateParts,
  isCompact = false,
  variant = 'card',
  children,
  className
}: JournalDateDisplayProps): React.JSX.Element {
  // Get time of day for gradient and greeting
  const timeOfDay = useMemo(() => getTimeOfDay(), [])
  const todayConfig = timeOfDayConfig[timeOfDay]

  // Should show greeting (only for day view)
  const showGreeting = viewState.type === 'day'

  // Should apply gradient background (only for day view)
  const showGradient = viewState.type === 'day'

  // Render day view
  if (viewState.type === 'day' && dateParts) {
    return (
      <div
        className={cn(
          'relative transition-all duration-500 ease-out w-full lg:px-12  lg:pr-[10px]',
          variant === 'card' ? 'rounded-b-3xl shadow-sm' : 'rounded-none',
          'pt-6 pb-10',
          showGradient && ['bg-gradient-to-br', todayConfig.gradient, todayConfig.darkGradient],
          className
        )}
      >
        <div className="flex w-full overflow-hidden">
          {/* Left Spacer - Animates from 0 to 1 flex-grow to push content to center */}
          <div
            className="transition-all duration-500 ease-in-out"
            style={{ flexGrow: isCompact ? 1 : 0 }}
          />

          <div
            className={cn('transition-all duration-500 ease-in-out shrink-0 min-w-0')}
            style={{
              width: isCompact ? 'min(100%, 48rem)' : '100%'
            }}
          >
            {/* Inner wrapper for baseline alignment and page margins */}
            <div
              className={cn(
                'flex flex-col transition-all duration-500 ease-in-out px-8 lg:px-12',
                !isCompact && 'pl-6 lg:pl-8'
              )}
            >
              {/* Navigation / Actions Slot */}
              {children && <div className="mb-6">{children}</div>}

              {/* Greeting */}
              {showGreeting && <Greeting timeOfDay={timeOfDay} className="mb-6" />}

              {/* Large date: "January 11, 2026" */}
              <h1 className="font-display text-4xl lg:text-5xl font-bold tracking-tight text-foreground">
                {dateParts.month} {dateParts.day}, {dateParts.year}
              </h1>

              {/* Day of week */}
              <p className="font-serif text-lg text-muted-foreground/70 mt-1">
                {dateParts.dayName}
              </p>
            </div>
          </div>

          {/* Right Spacer - Always grows to take remaining space */}
          <div className="flex-grow transition-all duration-500 ease-in-out" />
        </div>
      </div>
    )
  }

  // Render month view
  if (viewState.type === 'month') {
    const monthName = getMonthName(viewState.month)

    return (
      <div className={cn('py-6 w-full', className)}>
        <div className="px-8 lg:px-12">
          {/* Large date: "December 2024" */}
          <h1 className="font-display text-3xl lg:text-4xl font-normal tracking-tight text-foreground">
            {monthName} {viewState.year}
          </h1>

          {/* Subtitle */}
          <p className="font-serif text-lg text-muted-foreground/70 mt-1 italic">
            All journal entries for this month
          </p>
        </div>
      </div>
    )
  }

  // Render year view
  if (viewState.type === 'year') {
    return (
      <div className={cn('py-6 w-full', className)}>
        <div className="px-8 lg:px-12">
          {/* Large date: "2024" */}
          <h1 className="font-display text-3xl lg:text-4xl font-normal tracking-tight text-foreground">
            {viewState.year}
          </h1>

          {/* Subtitle */}
          <p className="font-serif text-lg text-muted-foreground/70 mt-1 italic">
            Select a month to view entries
          </p>
        </div>
      </div>
    )
  }

  // Fallback (should never reach here)
  return <></>
}

export default JournalDateDisplay
