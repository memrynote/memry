import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SlidersHorizontal } from '@/lib/icons'
import { CalendarDayView } from './calendar-day-view'
import { CalendarEventEditorDrawer, type CalendarEventDraft } from './calendar-event-editor-drawer'
import { CalendarMonthView } from './calendar-month-view'
import { CalendarToolbar, type CalendarWorkspaceView } from './calendar-toolbar'
import { CalendarWeekView } from './calendar-week-view'
import { CalendarYearView } from './calendar-year-view'
import type { CalendarProjectionItem, CalendarSourceRecord } from '@/services/calendar-service'

interface CalendarShellProps {
  view: CalendarWorkspaceView
  anchorDate: string
  items: CalendarProjectionItem[]
  importedSources: CalendarSourceRecord[]
  isLoading: boolean
  showMemryItems: boolean
  showImportedCalendars: boolean
  selectedImportedSourceIds: string[]
  editorState: { mode: 'create' | 'edit'; draft: CalendarEventDraft } | null
  isSaving: boolean
  onViewChange: (view: CalendarWorkspaceView) => void
  onPrevious: () => void
  onNext: () => void
  onToday: () => void
  onCreateEvent: () => void
  onToggleMemryItems: () => void
  onToggleImportedCalendars: () => void
  onToggleImportedSource: (sourceId: string) => void
  onSelectItem: (item: CalendarProjectionItem) => void
  onEditorClose: () => void
  onEditorDraftChange: (draft: CalendarEventDraft) => void
  onEditorSave: () => void
  onAnchorChange?: (date: string) => void
  onQuickSave?: (draft: CalendarEventDraft) => void
  onCreateEventWithRange?: (startAt: string, endAt: string, isAllDay: boolean) => void
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
  editorState,
  isSaving,
  onViewChange,
  onPrevious,
  onNext,
  onToday,
  onCreateEvent,
  onToggleMemryItems,
  onToggleImportedCalendars,
  onToggleImportedSource,
  onSelectItem,
  onEditorClose,
  onEditorDraftChange,
  onEditorSave,
  onAnchorChange,
  onQuickSave,
  onCreateEventWithRange
}: CalendarShellProps): React.JSX.Element {
  const viewProps = { anchorDate, items, onSelectItem }

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
        extraActions={filterPopover}
      />

      <div className="min-h-0 flex-1">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading calendar...
          </div>
        ) : view === 'day' ? (
          <CalendarDayView {...viewProps} onQuickSave={onQuickSave} onCreateEventWithRange={onCreateEventWithRange} />
        ) : view === 'week' ? (
          <CalendarWeekView {...viewProps} onQuickSave={onQuickSave} onCreateEventWithRange={onCreateEventWithRange} />
        ) : view === 'month' ? (
          <CalendarMonthView {...viewProps} onQuickSave={onQuickSave} onCreateEventWithRange={onCreateEventWithRange} />
        ) : (
          <CalendarYearView {...viewProps} onViewChange={onViewChange} onAnchorChange={onAnchorChange} />
        )}
      </div>

      {editorState && (
        <CalendarEventEditorDrawer
          open={true}
          mode={editorState.mode}
          draft={editorState.draft}
          isSaving={isSaving}
          onClose={onEditorClose}
          onDraftChange={onEditorDraftChange}
          onSave={onEditorSave}
        />
      )}
    </div>
  )
}

export default CalendarShell
