import { CalendarDayView } from './calendar-day-view'
import { CalendarEventEditorDrawer, type CalendarEventDraft } from './calendar-event-editor-drawer'
import { CalendarMonthView } from './calendar-month-view'
import { CalendarSidebar } from './calendar-sidebar'
import { CalendarToolbar, type CalendarWorkspaceView } from './calendar-toolbar'
import { CalendarWeekView } from './calendar-week-view'
import { CalendarYearView } from './calendar-year-view'
import type { CalendarProjectionItem, CalendarSourceRecord } from '@/services/calendar-service'

interface CalendarShellProps {
  view: CalendarWorkspaceView
  rangeLabel: string
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
}

export function CalendarShell({
  view,
  rangeLabel,
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
  onEditorSave
}: CalendarShellProps): React.JSX.Element {
  const viewProps = {
    anchorDate,
    items,
    onSelectItem
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="calendar-page">
      <CalendarToolbar
        view={view}
        rangeLabel={rangeLabel}
        onViewChange={onViewChange}
        onPrevious={onPrevious}
        onNext={onNext}
        onToday={onToday}
        onCreateEvent={onCreateEvent}
      />

      <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
        <CalendarSidebar
          showMemryItems={showMemryItems}
          showImportedCalendars={showImportedCalendars}
          importedSources={importedSources}
          selectedImportedSourceIds={selectedImportedSourceIds}
          onToggleMemryItems={onToggleMemryItems}
          onToggleImportedCalendars={onToggleImportedCalendars}
          onToggleImportedSource={onToggleImportedSource}
        />

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {isLoading ? (
            <div className="rounded-2xl border border-dashed border-border px-4 py-12 text-sm text-muted-foreground">
              Loading calendar projection...
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border px-4 py-12 text-sm text-muted-foreground">
              No calendar items in this range.
            </div>
          ) : view === 'day' ? (
            <CalendarDayView {...viewProps} />
          ) : view === 'week' ? (
            <CalendarWeekView {...viewProps} />
          ) : view === 'month' ? (
            <CalendarMonthView {...viewProps} />
          ) : (
            <CalendarYearView {...viewProps} />
          )}
        </div>
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
