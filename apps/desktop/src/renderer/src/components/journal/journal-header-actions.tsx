import { cn } from '@/lib/utils'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Bookmark2,
  MoreVertical,
  Maximize,
  Settings,
  ChevronLeft,
  ChevronRight,
  Download,
  FilePaste,
  Hierarchy,
  PenLine,
  Save,
  Search,
  Copy,
  FolderOpen,
  ExternalLink,
  Paperclip,
  Trash2
} from '@/lib/icons'
import { PageGraphIcon } from '@/lib/icons/page-icons'
import { Switch } from '@/components/ui/switch'
import { Picker } from '@/components/ui/picker'
import { useFileActionLabels } from '@/hooks/use-file-action-labels'
import { JournalReminderButton } from './journal-reminder-button'
import type { JournalViewState } from './date-breadcrumb'
import { useT } from '@memry/i18n/renderer'

/** Overflow menu actions. Mirrors the note page's menu minus the actions a
 * date-named journal file cannot take (rename, move, reveal in sidebar). */
export type JournalMenuAction =
  | 'local-graph'
  | 'find'
  | 'version-history'
  | 'export'
  | 'insert-template'
  | 'save-as-template'
  | 'copy-path'
  | 'reveal-in-finder'
  | 'open-external'
  | 'attachments'
  | 'settings'
  | 'delete'

interface JournalHeaderActionsProps {
  viewState: JournalViewState
  isBookmarked: boolean
  isFullWidth: boolean
  /** An entry file exists for the day. Actions that need a file are hidden until it does. */
  hasEntry: boolean
  /** The day on screen (YYYY-MM-DD). Reminders are keyed by date, so they need no entry. */
  journalDate: string | null
  isMindMapAvailable?: boolean
  isMindMapOpen?: boolean
  isLocalGraphOpen?: boolean
  reviewPill?: ReactNode
  onPrevious: () => void
  onNext: () => void
  onToggleFullWidth: () => void
  onBookmarkToggle: () => void
  onToggleMindMap?: () => void
  onVersionHistory: () => void
  onExport: () => void
  onOpenSettings: () => void
  onMenuAction?: (action: JournalMenuAction) => void
}

const ACTION_BTN =
  'size-7 hover:bg-surface-active transition-all duration-150 ease-out active:scale-95 active:bg-surface-active/70 disabled:active:scale-100'

export function JournalHeaderActions({
  viewState,
  isBookmarked,
  isFullWidth,
  hasEntry,
  journalDate,
  isMindMapAvailable = false,
  isMindMapOpen = false,
  isLocalGraphOpen = false,
  reviewPill,
  onPrevious,
  onNext,
  onToggleFullWidth,
  onBookmarkToggle,
  onToggleMindMap,
  onVersionHistory,
  onExport,
  onOpenSettings,
  onMenuAction
}: JournalHeaderActionsProps) {
  const { t } = useT('journal')
  const { t: tNotes } = useT('notes')
  const fileActions = useFileActionLabels()
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const previousLabel = viewState.type === 'month' ? t('nav.previousMonth') : t('nav.previousYear')
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

  const bookmarkLabel = isBookmarked ? t('action.removeBookmark') : t('action.addBookmark')
  const mindMapLabel = isMindMapOpen
    ? tNotes('editor.toolbar.hideMindMap')
    : tNotes('editor.toolbar.showMindMap')

  const handleAction = (action: string): void => {
    // Full width flips in place, like the note menu: the switch is the feedback.
    if (action === 'full-width') {
      onToggleFullWidth()
      return
    }
    setMoreMenuOpen(false)
    if (action === 'version-history') onVersionHistory()
    else if (action === 'export') onExport()
    else if (action === 'settings') onOpenSettings()
    else onMenuAction?.(action as JournalMenuAction)
  }

  return (
    <div className="flex items-center gap-0.5">
      {reviewPill}

      {journalDate && (
        <JournalReminderButton journalDate={journalDate} disabled={false} className={ACTION_BTN} />
      )}

      <Button
        variant="ghost"
        size="icon"
        className={ACTION_BTN}
        onClick={onBookmarkToggle}
        title={bookmarkLabel}
        aria-label={bookmarkLabel}
      >
        <Bookmark2
          className={cn(
            'h-3.5 w-3.5',
            isBookmarked ? 'fill-accent-orange text-accent-orange' : 'text-muted-foreground'
          )}
        />
      </Button>

      {isMindMapAvailable && onToggleMindMap && (
        <Button
          variant="ghost"
          size="icon"
          className={ACTION_BTN}
          onClick={onToggleMindMap}
          aria-pressed={isMindMapOpen}
          data-testid="journal-mind-map-toggle"
          title={mindMapLabel}
          aria-label={mindMapLabel}
        >
          <Hierarchy
            className={cn(
              'h-3.5 w-3.5',
              isMindMapOpen ? 'text-accent-orange' : 'text-muted-foreground'
            )}
          />
        </Button>
      )}

      <Picker
        value={null}
        closeOnSelect={false}
        onValueChange={handleAction}
        open={moreMenuOpen}
        onOpenChange={setMoreMenuOpen}
      >
        <Picker.Trigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={ACTION_BTN}
            data-testid="journal-more-menu"
            aria-label={t('aria.moreOptions')}
          >
            <MoreVertical className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </Picker.Trigger>
        <Picker.Content align="end">
          <Picker.List>
            {hasEntry && (
              <Picker.Item
                value="local-graph"
                label={
                  isLocalGraphOpen
                    ? tNotes('editor.toolbar.hideLocalGraph')
                    : tNotes('editor.toolbar.showLocalGraph')
                }
                icon={<PageGraphIcon className="size-4" />}
              />
            )}
            <Picker.Item
              value="find"
              label={tNotes('editor.toolbar.find')}
              icon={<Search className="size-4" />}
            />
            {hasEntry && (
              <>
                <Picker.Item
                  value="version-history"
                  label={t('action.versionHistory')}
                  icon={<FilePaste className="size-4" />}
                />
                <Picker.Item
                  value="export"
                  label={t('action.export')}
                  icon={<Download className="size-4" />}
                />
              </>
            )}
            <Picker.Item
              value="insert-template"
              label={tNotes('editor.slashMenu.insertTemplate.title')}
              icon={<PenLine className="size-4" />}
            />
            {hasEntry && (
              <Picker.Item
                value="save-as-template"
                label={tNotes('editor.toolbar.saveAsTemplate')}
                icon={<Save className="size-4" />}
              />
            )}
            <Picker.Item
              value="full-width"
              label={t('action.fullWidth')}
              icon={<Maximize className="size-4" />}
              trailing={
                <Switch
                  checked={isFullWidth}
                  className="pointer-events-none h-4 w-7"
                  tabIndex={-1}
                />
              }
            />
            {hasEntry && (
              <>
                <Picker.Separator />
                <Picker.Item
                  value="copy-path"
                  label={tNotes('editor.toolbar.copyPath')}
                  icon={<Copy className="size-4" />}
                />
                <Picker.Item
                  value="reveal-in-finder"
                  label={fileActions.revealInFolder}
                  icon={<FolderOpen className="size-4" />}
                />
                <Picker.Item
                  value="open-external"
                  label={fileActions.openInDefaultApp}
                  icon={<ExternalLink className="size-4" />}
                />
                <Picker.Item
                  value="attachments"
                  label={tNotes('editor.toolbar.attachments')}
                  icon={<Paperclip className="size-4" />}
                />
              </>
            )}
            <Picker.Separator />
            <Picker.Item
              value="settings"
              label={t('action.journalSettings')}
              icon={<Settings className="size-4" />}
            />
            {hasEntry && (
              <>
                <Picker.Separator />
                <Picker.Item
                  value="delete"
                  label={t('action.deleteEntry')}
                  icon={<Trash2 className="size-4" />}
                  destructive
                />
              </>
            )}
          </Picker.List>
        </Picker.Content>
      </Picker>
    </div>
  )
}
