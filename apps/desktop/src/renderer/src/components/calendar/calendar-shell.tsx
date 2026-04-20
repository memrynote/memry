import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RefreshCw, SlidersHorizontal } from '@/lib/icons'
import { CalendarDayView } from './calendar-day-view'
import { CalendarEventPopover, type CalendarEventReadOnlyMetadata } from './calendar-event-popover'
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
  popoverState: {
    mode: 'create' | 'edit'
    draft: CalendarEventDraft
    anchorRect: AnchorRect
    /** M5: rich read-only metadata surfaced below the editor in edit mode. */
    readOnlyMetadata?: CalendarEventReadOnlyMetadata
  } | null
  isSaving: boolean
  onViewChange: (view: CalendarWorkspaceView) => void
  onPrevious: () => void
  onNext: () => void
  onToday: () => void
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
  popoverState,
  isSaving,
  onViewChange,
  onPrevious,
  onNext,
  onToday,
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
  const viewProps = { anchorDate, items, onSelectItem }
  const chipViewProps = { ...viewProps, onDeleteItem }
  const [isRefreshing, setIsRefreshing] = useState(false)
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
      aria-label="Refresh Google calendars"
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
          aria-label="Filter calendars"
        >
          <SlidersHorizontal className="size-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="space-y-5">
          <div className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Sources
            </h2>
            <label className="flex items-center justify-between gap-3 text-sm text-foreground">
              <span>Memry items</span>
              <input
                type="checkbox"
                aria-label="Memry items"
                checked={showMemryItems}
                onChange={onToggleMemryItems}
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm text-foreground">
              <span>Imported calendars</span>
              <input
                type="checkbox"
                aria-label="Imported calendars"
                checked={showImportedCalendars}
                onChange={onToggleImportedCalendars}
              />
            </label>
          </div>

          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Event types
            </h3>
            {VISUAL_TYPE_ORDER.map((visualType) => {
              const meta = VISUAL_TYPE_META[visualType]
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
                    {meta.label}
                  </span>
                  <input
                    type="checkbox"
                    aria-label={meta.label}
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
                Google calendars
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
            Loading calendar...
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
    </div>
  )
}

export default CalendarShell
