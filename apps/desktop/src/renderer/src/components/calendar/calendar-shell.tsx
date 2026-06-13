import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
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
  onToggleMemryItems: () => void
  onToggleImportedCalendars: () => void
  onToggleImportedSource: (sourceId: string) => void
  onToggleVisualType: (visualType: CalendarProjectionVisualType) => void
  onSelectItem: (item: CalendarProjectionItem, rect: AnchorRect) => void
  onDeleteItem?: (item: CalendarProjectionItem) => void
  onPopoverDismiss: () => void
  onPopoverDraftChange: (draft: CalendarEventDraft) => void
  onPopoverSave: () => void
  onAnchorChange?: (date: string) => void
  onWeekVisibleRangeChange?: (startDate: string) => void
  onQuickSave?: (draft: CalendarEventDraft) => void | Promise<void>
  onCreateEventWithRange?: (
    startAt: string,
    endAt: string,
    isAllDay: boolean,
    anchorRect: AnchorRect
  ) => void
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
  onToggleMemryItems,
  onToggleImportedCalendars,
  onToggleImportedSource,
  onToggleVisualType,
  onSelectItem,
  onDeleteItem,
  onPopoverDismiss,
  onPopoverDraftChange,
  onPopoverSave,
  onAnchorChange,
  onWeekVisibleRangeChange,
  onQuickSave,
  onCreateEventWithRange
}: CalendarShellProps): React.JSX.Element {
  const viewProps = { anchorDate, items, selectedItemId, onSelectItem }
  const chipViewProps = { ...viewProps, onDeleteItem }
  const [isRefreshing, setIsRefreshing] = useState(false)
  const { t } = useT('calendar')
  const hasGoogleCalendars = importedSources.length > 0

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
              <input
                type="checkbox"
                aria-label={t('filter.memry-items')}
                checked={showMemryItems}
                onChange={onToggleMemryItems}
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm text-foreground">
              <span>{t('filter.imported-calendars')}</span>
              <input
                type="checkbox"
                aria-label={t('filter.imported-calendars')}
                checked={showImportedCalendars}
                onChange={onToggleImportedCalendars}
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
                  <input
                    type="checkbox"
                    aria-label={label}
                    checked={selectedVisualTypes.includes(visualType)}
                    onChange={() => onToggleVisualType(visualType)}
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
                  className="flex items-center justify-between gap-3 text-sm text-foreground"
                >
                  <span>{source.title}</span>
                  <input
                    type="checkbox"
                    aria-label={source.title}
                    checked={selectedImportedSourceIds.includes(source.id)}
                    disabled={!showImportedCalendars}
                    onChange={() => onToggleImportedSource(source.id)}
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
      className="@container flex h-full min-h-0 flex-col bg-background"
      data-testid="calendar-page"
    >
      <CalendarToolbar
        view={view}
        anchorDate={anchorDate}
        onViewChange={onViewChange}
        onPrevious={onPrevious}
        onNext={onNext}
        onToday={onToday}
        onCreateEvent={onCreateEvent}
        extraActions={
          <>
            {refreshButton}
            {filterPopover}
          </>
        }
      />

      <div className="min-h-0 flex-1">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t('state.loading-calendar')}
          </div>
        ) : view === 'day' ? (
          <CalendarDayView
            {...chipViewProps}
            onQuickSave={onQuickSave}
            onCreateEventWithRange={onCreateEventWithRange}
          />
        ) : view === 'week' ? (
          <CalendarWeekView
            {...chipViewProps}
            todayRequestKey={todayRequestKey}
            onQuickSave={onQuickSave}
            onCreateEventWithRange={onCreateEventWithRange}
            onVisibleDayStartChange={(_, startDate) => onWeekVisibleRangeChange?.(startDate)}
          />
        ) : view === 'month' ? (
          <CalendarMonthView
            {...chipViewProps}
            onQuickSave={onQuickSave}
            onCreateEventWithRange={onCreateEventWithRange}
          />
        ) : (
          <CalendarYearView
            {...viewProps}
            onViewChange={onViewChange}
            onAnchorChange={onAnchorChange}
          />
        )}
      </div>

      {popoverState && (
        <CalendarEventPopover
          anchorRect={popoverState.anchorRect}
          mode={popoverState.mode}
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
