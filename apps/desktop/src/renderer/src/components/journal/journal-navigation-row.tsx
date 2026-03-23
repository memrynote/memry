/**
 * JournalNavigationRow Component
 * Top navigation bar for journal page with arrows, Today button, and action buttons
 * Shared across day, month, and year views
 */

import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  Bookmark,
  MoreHorizontal,
  History
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { JournalReminderButton } from './journal-reminder-button'
import type { JournalViewState } from './date-breadcrumb'

// =============================================================================
// TYPES
// =============================================================================

export interface JournalNavigationRowProps {
  /** Current view state */
  viewState: JournalViewState
  /** Whether currently viewing today's date */
  isToday: boolean
  /** Whether the view is in compact mode */
  isCompact?: boolean
  /** Whether the current entry is bookmarked */
  isBookmarked: boolean
  /** Whether an entry exists for the current date */
  hasEntry: boolean
  /** Current journal date (for reminder button) */
  journalDate: string | null
  /** Callback for previous navigation (day/month/year) */
  onPrevious: () => void
  /** Callback for next navigation (day/month/year) */
  onNext: () => void
  /** Callback for Today button */
  onToday: () => void
  /** Callback for focus mode toggle */
  onFocusToggle: () => void
  /** Callback for bookmark toggle */
  onBookmarkToggle: () => void
  /** Callback to open version history */
  onVersionHistory: () => void
  /** Callback to open export dialog */
  onExport: () => void
  /** Additional CSS classes */
  className?: string
}

// =============================================================================
// NAV ARROW COMPONENT
// =============================================================================

interface NavArrowProps {
  direction: 'prev' | 'next'
  onClick: () => void
  label: string
}

function NavArrow({ direction, onClick, label }: NavArrowProps) {
  const Icon = direction === 'prev' ? ChevronLeft : ChevronRight

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      aria-label={label}
      className={cn(
        'size-8 rounded-md',
        'text-foreground/60 hover:text-foreground',
        'hover:bg-foreground/10',
        'transition-all duration-200'
      )}
    >
      <Icon className="size-4" />
    </Button>
  )
}

// =============================================================================
// TODAY BUTTON COMPONENT
// =============================================================================

interface TodayButtonProps {
  onClick: () => void
}

function TodayButton({ onClick }: TodayButtonProps) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className={cn(
        'h-8 px-4 rounded-md',
        'text-xs font-semibold',
        'border-foreground/10 bg-background/90 shadow-sm backdrop-blur-md',
        'hover:bg-background hover:border-foreground/20',
        'transition-all duration-200'
      )}
    >
      Today
    </Button>
  )
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function JournalNavigationRow({
  viewState,
  isToday,
  isCompact = false,
  isBookmarked,
  hasEntry,
  journalDate,
  onPrevious,
  onNext,
  onToday,
  onFocusToggle,
  onBookmarkToggle,
  onVersionHistory,
  onExport,
  className
}: JournalNavigationRowProps): React.JSX.Element {
  // Determine navigation labels based on view type
  const getNavLabels = () => {
    switch (viewState.type) {
      case 'day':
        return { prev: 'Previous day', next: 'Next day' }
      case 'month':
        return { prev: 'Previous month', next: 'Next month' }
      case 'year':
        return { prev: 'Previous year', next: 'Next year' }
    }
  }

  const navLabels = getNavLabels()

  return (
    <nav
      aria-label="Journal navigation"
      className={cn('flex items-center justify-between', className)}
    >
      {/* Left side - Navigation arrows and Today button */}
      <div className="flex items-center gap-1">
        <NavArrow direction="prev" onClick={onPrevious} label={navLabels.prev} />
        <NavArrow direction="next" onClick={onNext} label={navLabels.next} />

        {/* Today button - show in day view if not today */}
        {viewState.type === 'day' && !isToday && (
          <div className="ml-1">
            <TodayButton onClick={onToday} />
          </div>
        )}
      </div>

      {/* Right side - Action buttons */}
      <div className="flex items-center gap-1">
        {/* Reminder Button - only in day view with entry */}
        {viewState.type === 'day' && hasEntry && journalDate && (
          <JournalReminderButton journalDate={journalDate} disabled={false} />
        )}

        {/* Bookmark Button - only in day view with entry */}
        {viewState.type === 'day' && hasEntry && (
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'size-8 rounded-md',
              'text-foreground/60 hover:text-foreground',
              'hover:bg-foreground/10',
              'transition-all duration-200'
            )}
            onClick={onBookmarkToggle}
            title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
          >
            <Bookmark className={cn('size-4', isBookmarked && 'fill-current text-amber-500')} />
            <span className="sr-only">{isBookmarked ? 'Remove bookmark' : 'Add bookmark'}</span>
          </Button>
        )}

        {/* More Options Menu - always in day view */}
        {viewState.type === 'day' && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'size-8 rounded-md',
                  'text-foreground/60 hover:text-foreground',
                  'hover:bg-foreground/10',
                  'transition-all duration-200'
                )}
              >
                <MoreHorizontal className="size-4" />
                <span className="sr-only">More options</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={onFocusToggle}>
                {isCompact ? (
                  <>
                    <Maximize2 className="mr-2 size-4" />
                    <span>Full Mode</span>
                    <DropdownMenuShortcut>⌘\</DropdownMenuShortcut>
                  </>
                ) : (
                  <>
                    <Minimize2 className="mr-2 size-4" />
                    <span>Compact Mode</span>
                    <DropdownMenuShortcut>⌘\</DropdownMenuShortcut>
                  </>
                )}
              </DropdownMenuItem>

              {hasEntry && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onVersionHistory}>
                    <History className="mr-2 size-4" />
                    Version History
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onExport}>Export</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </nav>
  )
}

export default JournalNavigationRow
