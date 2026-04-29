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
import { useT } from '@memry/i18n/renderer'
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
  const { t } = useT('journal')

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
      {t('date.relative.today')}
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
  const { t } = useT('journal')
  // Determine navigation labels based on view type
  const getNavLabels = () => {
    switch (viewState.type) {
      case 'day':
        return { prev: t('nav.previousDay'), next: t('nav.nextDay') }
      case 'month':
        return { prev: t('nav.previousMonth'), next: t('nav.nextMonth') }
      case 'year':
        return { prev: t('nav.previousYear'), next: t('nav.nextYear') }
    }
  }

  const navLabels = getNavLabels()

  return (
    <nav
      aria-label={t('nav.journalNavigation')}
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
            title={isBookmarked ? t('action.removeBookmark') : t('action.addBookmark')}
          >
            <Bookmark className={cn('size-4', isBookmarked && 'fill-current text-amber-500')} />
            <span className="sr-only">
              {isBookmarked ? t('action.removeBookmark') : t('action.addBookmark')}
            </span>
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
                <span className="sr-only">{t('aria.moreOptions')}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={onFocusToggle}>
                {isCompact ? (
                  <>
                    <Maximize2 className="mr-2 size-4" />
                    <span>{t('action.fullMode')}</span>
                    <DropdownMenuShortcut>⌘\</DropdownMenuShortcut>
                  </>
                ) : (
                  <>
                    <Minimize2 className="mr-2 size-4" />
                    <span>{t('action.compactMode')}</span>
                    <DropdownMenuShortcut>⌘\</DropdownMenuShortcut>
                  </>
                )}
              </DropdownMenuItem>

              {hasEntry && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onVersionHistory}>
                    <History className="mr-2 size-4" />
                    {t('action.versionHistory')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onExport}>{t('action.export')}</DropdownMenuItem>
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
