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
import { useT } from '@memry/i18n/renderer'

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
  const { t } = useT('journal')
  const previousLabel =
    viewState.type === 'month' ? t('nav.previousMonth') : t('nav.previousYear')
  const nextLabel = viewState.type === 'month' ? t('nav.nextMonth') : t('nav.nextYear')

  if (viewState.type === 'month' || viewState.type === 'year') {
    return (
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className={ACTION_BTN}
          onClick={onPrevious}
          aria-label={previousLabel}
        >
          <ChevronLeft className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={ACTION_BTN}
          onClick={onNext}
          aria-label={nextLabel}
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
          title={isBookmarked ? t('action.removeBookmark') : t('action.addBookmark')}
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
            <span className="sr-only">{t('aria.moreOptions')}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {hasEntry && (
            <>
              <DropdownMenuItem onClick={onVersionHistory}>
                <History className="mr-2 size-4" />
                {t('action.versionHistory')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onExport}>
                <Download className="mr-2 size-4" />
                {t('action.export')}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem onClick={onToggleFullWidth}>
            <Maximize className="mr-2 size-4" />
            <span className="flex-1">{t('action.fullWidth')}</span>
            <Switch checked={isFullWidth} className="pointer-events-none h-4 w-7" tabIndex={-1} />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onOpenSettings}>
            <Settings className="mr-2 size-4" />
            {t('action.journalSettings')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
