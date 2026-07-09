import type React from 'react'
import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { useJournalHeatmap } from '@/hooks/use-journal-heatmap'
import { journalKeys, ENTRY_STALE_TIME, ENTRY_GC_TIME } from '@/hooks/journal-query-keys'
import { journalService } from '@/services/journal-service'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useTabActions } from '@/contexts/tabs/context'
import { Skeleton } from '@/components/ui/skeleton'
import { formatTimeOfDay } from '@/lib/time-format'
import {
  buildWeekDays,
  recentEntryDates,
  relativeDayLabel,
  entrySnippet
} from '@/lib/home/journal-widget-data'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import { useT } from '@memry/i18n/renderer'

function localTodayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

export function JournalWidget({ size }: WidgetComponentProps): React.JSX.Element {
  const { t, i18n } = useT('common')
  const lang = i18n.language
  const { settings } = useGeneralSettings()
  const { openTab } = useTabActions()
  const limit = size === 'L' ? 4 : 2

  const todayIso = useMemo(() => localTodayIso(), [])
  const year = Number(todayIso.slice(0, 4))
  const thisYear = useJournalHeatmap(year)
  const prevYear = useJournalHeatmap(year - 1)

  const allEntries = useMemo(
    () => [...thisYear.data, ...prevYear.data],
    [thisYear.data, prevYear.data]
  )
  const entryDates = useMemo(
    () => new Set(allEntries.filter((e) => e.level > 0).map((e) => e.date)),
    [allEntries]
  )
  const weekDays = useMemo(
    () => buildWeekDays(todayIso, entryDates, lang),
    [todayIso, entryDates, lang]
  )
  const recentDates = useMemo(() => recentEntryDates(allEntries, limit), [allEntries, limit])

  const entryQueries = useQueries({
    queries: recentDates.map((date) => ({
      queryKey: journalKeys.entry(date),
      queryFn: () => journalService.getEntry(date),
      staleTime: ENTRY_STALE_TIME,
      gcTime: ENTRY_GC_TIME
    }))
  })

  const openJournal = (date: string): void => {
    openTab({
      type: 'journal',
      title: t('home.widget.journal'),
      icon: 'book-open',
      path: '/journal',
      isPinned: false,
      isModified: false,
      isDeleted: false,
      isPreview: false,
      viewState: { date }
    })
  }

  const labelText = (iso: string): string => {
    const label = relativeDayLabel(iso, todayIso, lang)
    if (label.kind === 'today') return t('home.widget.journalToday')
    if (label.kind === 'yesterday') return t('home.widget.journalYesterday')
    return label.text
  }

  if (thisYear.isLoading || prevYear.isLoading)
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label={t('state.loading')}>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    )

  if (thisYear.error || prevYear.error)
    return (
      <div className="text-xs text-destructive" role="alert">
        {t('home.widget.loadError')}
      </div>
    )

  return (
    <div className="flex flex-col gap-1">
      {/* Week strip: 7 days ending today */}
      <div className="flex items-end gap-1.5 pb-1.5">
        {weekDays.map((day) => (
          <button
            key={day.iso}
            type="button"
            onClick={() => openJournal(day.iso)}
            aria-label={day.iso}
            className="group/day flex flex-1 flex-col items-center gap-1.5 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]"
          >
            <span className="text-[10px] text-[var(--text-tertiary)]">{day.weekdayNarrow}</span>
            {/* Press feedback on pointer-down (apple-design §1): the day circle dips, instantly. */}
            <span
              className={`transition-transform duration-100 motion-safe:group-active/day:scale-90 ${
                day.isToday
                  ? 'flex size-8 items-center justify-center rounded-full bg-[var(--tint)] text-[12px] font-bold text-white'
                  : day.hasEntry
                    ? 'flex size-8 items-center justify-center rounded-full bg-[var(--tint-light)] text-[12px] font-semibold text-[var(--tint)] group-hover/day:bg-[var(--tint)]/20'
                    : 'flex size-8 items-center justify-center rounded-full border border-dashed text-[12px] text-[var(--text-tertiary)] group-hover/day:border-solid group-hover/day:text-foreground/70'
              }`}
            >
              {day.dayNum}
            </span>
          </button>
        ))}
      </div>

      {/* Recent entries */}
      {recentDates.length === 0 ? (
        <div className="border-t pt-2.5 text-xs text-muted-foreground">
          {t('home.noJournalEntriesYet')}
        </div>
      ) : (
        recentDates.map((date, index) => {
          const entry = entryQueries[index]?.data
          const time = entry?.createdAt
            ? formatTimeOfDay(new Date(entry.createdAt), settings.clockFormat)
            : null
          const snippet = entry ? entrySnippet(entry.content) : ''
          return (
            <button
              key={date}
              type="button"
              onClick={() => openJournal(date)}
              className="-mx-2 flex flex-col gap-1 border-t px-2 py-2.5 text-start hover:bg-muted/40 active:bg-muted/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]"
            >
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={`size-1.5 shrink-0 rounded-full bg-[var(--tint)] ${
                    index === 0 ? '' : 'opacity-50'
                  }`}
                />
                <span className="text-[13px] font-medium text-foreground/90">
                  {labelText(date)}
                </span>
                {time && <span className="text-[11px] text-text-tertiary">· {time}</span>}
              </span>
              {snippet && (
                <span className="ps-3 text-[13px] leading-5 text-text-tertiary">{snippet}</span>
              )}
            </button>
          )
        })
      )}
    </div>
  )
}
