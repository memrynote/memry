import { useT } from '@memry/i18n/renderer'
import { Checkbox } from '@/components/ui/checkbox'
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
  const { t } = useT('calendar')

  return (
    <aside className="w-full shrink-0 border-b border-border/70 bg-muted/20 px-6 py-5 xl:w-72 xl:border-b-0 xl:border-e">
      <div className="space-y-6">
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
            {t('filter.google-calendars')}
          </h3>

          {importedSources.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('empty.no-imported-calendars-yet')}</p>
          ) : (
            importedSources.map((source) => (
              <label
                key={source.id}
                data-testid={`calendar-filter-source-${source.id}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/70 px-3 py-2 text-sm text-foreground"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{source.title}</span>
                  {/* Discovery only pre-selects the primary calendar, so this
                      row is normal, not an error. Without the caption an empty
                      calendar is indistinguishable from one with no events. */}
                  {!source.isSelected && (
                    <span className="text-xs text-muted-foreground">{t('filter.not-syncing')}</span>
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
            ))
          )}
        </div>
      </div>
    </aside>
  )
}

export default CalendarSidebar
