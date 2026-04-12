import type { CalendarSourceRecord } from '@/services/calendar-service'

interface CalendarSidebarProps {
  showMemryItems: boolean
  showImportedCalendars: boolean
  importedSources: CalendarSourceRecord[]
  selectedImportedSourceIds: string[]
  onToggleMemryItems: () => void
  onToggleImportedCalendars: () => void
  onToggleImportedSource: (sourceId: string) => void
}

export function CalendarSidebar({
  showMemryItems,
  showImportedCalendars,
  importedSources,
  selectedImportedSourceIds,
  onToggleMemryItems,
  onToggleImportedCalendars,
  onToggleImportedSource
}: CalendarSidebarProps): React.JSX.Element {
  return (
    <aside className="w-full shrink-0 border-b border-border/70 bg-muted/20 px-6 py-5 xl:w-72 xl:border-b-0 xl:border-r">
      <div className="space-y-6">
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
            Google calendars
          </h3>

          {importedSources.length === 0 ? (
            <p className="text-sm text-muted-foreground">No imported calendars yet.</p>
          ) : (
            importedSources.map((source) => (
              <label
                key={source.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/70 px-3 py-2 text-sm text-foreground"
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
            ))
          )}
        </div>
      </div>
    </aside>
  )
}

export default CalendarSidebar
