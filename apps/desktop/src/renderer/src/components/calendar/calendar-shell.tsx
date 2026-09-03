import { useCallback, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RefreshCw, SlidersHorizontal } from '@/lib/icons'
import { CalendarDayView } from './calendar-day-view'
import { CalendarEventPopover, type CalendarEventReadOnlyMetadata } from './calendar-event-popover'
import { CalendarInboxSnoozePopover } from './calendar-inbox-snooze-popover'
import { CalendarNotePopover } from './calendar-note-popover'
import { CalendarMonthView } from './calendar-month-view'
import { CalendarToolbar, type CalendarWorkspaceView } from './calendar-toolbar'
import { CalendarWeekView } from './calendar-week-view'
import { CalendarYearView } from './calendar-year-view'
import type { AnchorRect, CalendarEventDraft } from './types'
import {
  refreshGoogleCalendarProvider,
  type CalendarProjectionItem,
  type CalendarProjectionVisualType,
  type CalendarSourceRecord
} from '@/services/calendar-service'
import { VISUAL_TYPE_META, VISUAL_TYPE_ORDER } from './visual-type-meta'
import { createLogger } from '@/lib/logger'

const log = createLogger('CalendarShell')

interface CalendarShellProps {
  view: CalendarWorkspaceView
  anchorDate: string
  items: CalendarProjectionItem[]
  importedSources: CalendarSourceRecord[]
  isLoading: boolean
  showMemryItems: boolean
  showImportedCalendars: boolean
  selectedImportedSourceIds: string[]
  selectedVisualTypes: CalendarProjectionVisualType[]
  selectedItemId: string | null
  popoverState: {
    mode: 'create' | 'edit'
    eventId?: string | null
    draft: CalendarEventDraft
    anchorRect: AnchorRect
    /** M5: rich read-only metadata surfaced below the editor in edit mode. */
    readOnlyMetadata?: CalendarEventReadOnlyMetadata
  } | null
  inboxSnoozePopoverState: {
    item: CalendarProjectionItem
    anchorRect: AnchorRect
  } | null
  onInboxSnoozeOpenInInbox: (itemId: string) => void
  onInboxSnoozeUnsnooze: (itemId: string) => void | Promise<void>
  onInboxSnoozeReschedule: (itemId: string, snoozeUntil: string) => void | Promise<void>
  onInboxSnoozePopoverDismiss: () => void
  notePopoverState: {
    item: CalendarProjectionItem
    anchorRect: AnchorRect
  } | null
  onNoteOpen: (noteId: string, anchorId?: string | null) => void
  onNotePopoverDismiss: () => void
  isSaving: boolean
  onViewChange: (view: CalendarWorkspaceView) => void
  onPrevious: () => void
  onNext: () => void
  onToday: () => void
  todayRequestKey?: number
  onCreateEvent: (anchorRect: AnchorRect) => void
  onSearchJump: (item: CalendarProjectionItem) => void
  onToggleMemryItems: () => void
  onToggleImportedCalendars: () => void
  onToggleImportedSource: (sourceId: string) => void
  onToggleVisualType: (visualType: CalendarProjectionVisualType) => void
  onSelectItem: (item: CalendarProjectionItem, rect: AnchorRect) => void
  onDeleteItem?: (item: CalendarProjectionItem) => void
  onAddToProject?: (eventId: string) => void
  onMoveEvent?: (
    item: CalendarProjectionItem,
    startAt: string,
    endAt: string
  ) => void | Promise<void>
  onPopoverDismiss: () => void
  onPopoverDraftChange: (draft: CalendarEventDraft) => void
  onPopoverSave: () => void
  onAnchorChange?: (date: string) => void
  onWeekVisibleRangeChange?: (startDate: string) => void
  onQuickSave?: (draft: CalendarEventDraft) => void | Promise<void>
  /** Toolbar CTA shown while Google Calendar is unlinked; injected by the page so the shell stays query-free. */
  googleConnectAction?: React.ReactNode
}

export function CalendarShell({
  view,
  anchorDate,
  items,
  importedSources,
  isLoading,
  showMemryItems,
  showImportedCalendars,
  selectedImportedSourceIds,
  selectedVisualTypes,
  selectedItemId,
  popoverState,
  inboxSnoozePopoverState,
  onInboxSnoozeOpenInInbox,
  onInboxSnoozeUnsnooze,
  onInboxSnoozeReschedule,
  onInboxSnoozePopoverDismiss,
  notePopoverState,
  onNoteOpen,
  onNotePopoverDismiss,
  isSaving,
  onViewChange,
  onPrevious,
  onNext,
  onToday,
  todayRequestKey,
  onCreateEvent,
  onSearchJump,
  onToggleMemryItems,
  onToggleImportedCalendars,
  onToggleImportedSource,
  onToggleVisualType,
  onSelectItem,
  onDeleteItem,
  onAddToProject,
  onMoveEvent,
  onPopoverDismiss,
  onPopoverDraftChange,
  onPopoverSave,
  onAnchorChange,
  onWeekVisibleRangeChange,
  onQuickSave,
  googleConnectAction
}: CalendarShellProps): React.JSX.Element {
  const viewProps = { anchorDate, items, selectedItemId, onSelectItem }
  const chipViewProps = { ...viewProps, onDeleteItem, onAddToProject }
  const [isRefreshing, setIsRefreshing] = useState(false)
  const { t } = useT('calendar')
  const hasGoogleCalendars = importedSources.length > 0

  // Scroll-edge state for the floating chrome: true once content is beneath it.
  // Views own their scroll containers (marked data-calendar-scroll); capture-phase
  // listening reaches them all without prop drilling.
  const [isScrolled, setIsScrolled] = useState(false)
  const handleScrollCapture = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target
    if (!(target instanceof HTMLElement) || !target.hasAttribute('data-calendar-scroll')) return
    setIsScrolled(target.scrollTop > 0)
  }, [])

  // One key per rendered period: prev/next remounts the grid. Week is keyed on
  // view only — its infinite scroller handles anchor changes itself.
  const viewKey =
    view === 'week'
      ? 'week'
      : view === 'day'
        ? `day:${anchorDate}`
        : view === 'month'
          ? `month:${anchorDate.slice(0, 7)}`
          : `year:${anchorDate.slice(0, 4)}`
  const renderedKeyRef = useRef(viewKey)
  if (renderedKeyRef.current !== viewKey) {
    // New period/view mounts unscrolled — drop the chrome edge with it
    setIsScrolled(false)
    renderedKeyRef.current = viewKey
  }

  const handleRefreshGoogle = async (): Promise<void> => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const result = await refreshGoogleCalendarProvider()
      if (!result.success && result.error) {
        log.warn('Google Calendar refresh failed', { error: result.error })
      }
    } catch (error) {
      log.warn('Google Calendar refresh threw', { error })
    } finally {
      setIsRefreshing(false)
    }
  }

  const refreshButton = hasGoogleCalendars ? (
    <Button
      variant="ghost"
      size="icon"
      className="size-9 rounded-lg"
      aria-label={t('filter.refresh-google-calendars')}
      disabled={isRefreshing}
      onClick={() => {
        void handleRefreshGoogle()
      }}
    >
      <RefreshCw className={`size-5${isRefreshing ? ' animate-spin' : ''}`} />
    </Button>
  ) : null

  const filterPopover = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-9 rounded-lg"
          aria-label={t('filter.filter-calendars')}
        >
          <SlidersHorizontal className="size-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="space-y-5">
          <div className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {t('filter.sources')}
            </h2>
            <label className="flex items-center justify-between gap-3 text-sm text-foreground">
              <span>{t('filter.memry-items')}</span>
              <Checkbox
                aria-label={t('filter.memry-items')}
                checked={showMemryItems}
                onCheckedChange={onToggleMemryItems}
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm text-foreground">
              <span>{t('filter.imported-calendars')}</span>
              <Checkbox
                aria-label={t('filter.imported-calendars')}
                checked={showImportedCalendars}
                onCheckedChange={onToggleImportedCalendars}
              />
            </label>
          </div>

          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {t('filter.event-types')}
            </h3>
            {VISUAL_TYPE_ORDER.map((visualType) => {
              const meta = VISUAL_TYPE_META[visualType]
              const label = t(meta.labelKey)
              return (
                <label
                  key={visualType}
                  className="flex items-center justify-between gap-3 text-sm text-foreground"
                >
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="size-3 rounded-full ring-1 ring-border"
                      style={{ backgroundColor: meta.swatchColor }}
                    />
                    {label}
                  </span>
                  <Checkbox
                    aria-label={label}
                    checked={selectedVisualTypes.includes(visualType)}
                    onCheckedChange={() => onToggleVisualType(visualType)}
                  />
                </label>
              )
            })}
          </div>

          {importedSources.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {t('filter.google-calendars')}
              </h3>
              {importedSources.map((source) => (
                <label
                  key={source.id}
                  data-testid={`calendar-filter-source-${source.id}`}
                  className="flex items-center justify-between gap-3 text-sm text-foreground"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{source.title}</span>
                    {!source.isSelected && (
                      <span className="text-xs text-muted-foreground">
                        {t('filter.not-syncing')}
                      </span>
                    )}
                  </span>
                  <Checkbox
                    className="shrink-0"
                    aria-label={source.title}
                    checked={selectedImportedSourceIds.includes(source.id)}
                    disabled={!showImportedCalendars}
                    onCheckedChange={() => onToggleImportedSource(source.id)}
                  />
                </label>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )

  return (
    <div
      className="@container relative flex h-full min-h-0 flex-col bg-background"
      data-testid="calendar-page"
      onScrollCapture={handleScrollCapture}
    >
      {/* Floating chrome — translucent material; the year grid scrolls beneath it */}
      <div
        data-scrolled={isScrolled || undefined}
        className="page-chrome absolute inset-x-0 top-0 z-30"
      >
        <CalendarToolbar
          view={view}
          anchorDate={anchorDate}
          onViewChange={onViewChange}
          onPrevious={onPrevious}
          onNext={onNext}
          onToday={onToday}
          onCreateEvent={onCreateEvent}
          onSearchJump={onSearchJump}
          extraActions={
            <>
              {googleConnectAction}
              {refreshButton}
              {filterPopover}
            </>
          }
        />
      </div>

      {/* Year owns its offset inside the scroller so months pass under the chrome */}
      <div className={cn('min-h-0 flex-1 overflow-x-clip', view !== 'year' && 'pt-12')}>
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t('state.loading-calendar')}
          </div>
        ) : (
          <div key={viewKey} className="h-full">
            {view === 'day' ? (
              <CalendarDayView
                {...chipViewProps}
                onMoveEvent={onMoveEvent}
                onQuickSave={onQuickSave}
              />
            ) : view === 'week' ? (
              <CalendarWeekView
                {...chipViewProps}
                onMoveEvent={onMoveEvent}
                todayRequestKey={todayRequestKey}
                onQuickSave={onQuickSave}
                onVisibleDayStartChange={(_, startDate) => onWeekVisibleRangeChange?.(startDate)}
              />
            ) : view === 'month' ? (
              <CalendarMonthView {...chipViewProps} onQuickSave={onQuickSave} />
            ) : (
              <CalendarYearView
                {...viewProps}
                onViewChange={onViewChange}
                onAnchorChange={onAnchorChange}
              />
            )}
          </div>
        )}
      </div>

      {popoverState && (
        <CalendarEventPopover
          anchorRect={popoverState.anchorRect}
          mode={popoverState.mode}
          eventId={popoverState.eventId}
          draft={popoverState.draft}
          isSaving={isSaving}
          onDraftChange={onPopoverDraftChange}
          onSave={onPopoverSave}
          onDismiss={onPopoverDismiss}
          readOnlyMetadata={popoverState.readOnlyMetadata}
        />
      )}

      {inboxSnoozePopoverState && (
        <CalendarInboxSnoozePopover
          item={inboxSnoozePopoverState.item}
          anchorRect={inboxSnoozePopoverState.anchorRect}
          onOpenInInbox={onInboxSnoozeOpenInInbox}
          onUnsnooze={onInboxSnoozeUnsnooze}
          onReschedule={onInboxSnoozeReschedule}
          onDismiss={onInboxSnoozePopoverDismiss}
        />
      )}

      {notePopoverState && (
        <CalendarNotePopover
          item={notePopoverState.item}
          anchorRect={notePopoverState.anchorRect}
          onOpenNote={onNoteOpen}
          onDismiss={onNotePopoverDismiss}
        />
      )}
    </div>
  )
}

export default CalendarShell
