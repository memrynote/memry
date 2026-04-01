import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Bookmark,
  MoreVertical,
  Maximize,
  History,
  Settings,
  ChevronLeft,
  ChevronRight,
  Download
} from '@/lib/icons'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { JournalReminderButton } from './journal-reminder-button'
import type { JournalViewState } from './date-breadcrumb'

interface JournalHeaderActionsProps {
  viewState: JournalViewState
  isBookmarked: boolean
  isFullWidth: boolean
  hasEntry: boolean
  journalDate: string | null
  onPrevious: () => void
  onNext: () => void
  onToggleFullWidth: () => void
  onBookmarkToggle: () => void
  onVersionHistory: () => void
  onExport: () => void
  onOpenSettings: () => void
}

const ACTION_BTN = 'size-7 hover:bg-surface-active'

export function JournalHeaderActions({
  viewState,
  isBookmarked,
  isFullWidth,
  hasEntry,
  journalDate,
  onPrevious,
  onNext,
  onToggleFullWidth,
  onBookmarkToggle,
  onVersionHistory,
  onExport,
  onOpenSettings
}: JournalHeaderActionsProps) {
  if (viewState.type === 'month' || viewState.type === 'year') {
    return (
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className={ACTION_BTN}
          onClick={onPrevious}
          aria-label={`Previous ${viewState.type}`}
        >
          <ChevronLeft className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={ACTION_BTN}
          onClick={onNext}
          aria-label={`Next ${viewState.type}`}
        >
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-0.5">
      {hasEntry && journalDate && (
        <JournalReminderButton journalDate={journalDate} disabled={false} />
      )}

      {hasEntry && (
        <Button
          variant="ghost"
          size="icon"
          className={ACTION_BTN}
          onClick={onBookmarkToggle}
          title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
        >
          <Bookmark
            className={cn(
              'h-3.5 w-3.5',
              isBookmarked ? 'fill-current text-amber-500' : 'text-muted-foreground'
            )}
          />
        </Button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className={ACTION_BTN}>
            <MoreVertical className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="sr-only">More options</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {hasEntry && (
            <>
              <DropdownMenuItem onClick={onVersionHistory}>
                <History className="mr-2 size-4" />
                Version History
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onExport}>
                <Download className="mr-2 size-4" />
                Export
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem onClick={onToggleFullWidth}>
            <Maximize className="mr-2 size-4" />
            <span className="flex-1">Full width</span>
            <Switch checked={isFullWidth} className="pointer-events-none h-4 w-7" tabIndex={-1} />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onOpenSettings}>
            <Settings className="mr-2 size-4" />
            Journal Settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
