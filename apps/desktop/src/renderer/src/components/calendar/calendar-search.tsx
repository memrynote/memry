import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useT } from '@memry/i18n/renderer'
import { Search, X } from '@/lib/icons'
import { calendarService, type CalendarProjectionItem } from '@/services/calendar-service'
import { calendarRangeKeys } from '@/hooks/use-calendar-range'
import { VISUAL_TYPE_META } from './visual-type-meta'
import { filterCalendarItems } from './calendar-search-filter'

const SEARCH_WINDOW_YEARS_PAST = 2
const SEARCH_WINDOW_YEARS_FUTURE = 3

interface CalendarSearchProps {
  onJump: (item: CalendarProjectionItem) => void
}

export function CalendarSearch({ onJump }: CalendarSearchProps): React.JSX.Element {
  const { t, i18n } = useT('calendar')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Captured when search opens so proximity sorting stays stable across renders.
  const [nowMs, setNowMs] = useState(0)

  // ponytail: search scans a fixed ±-year window of the same projection the
  // calendar renders. Widen the window or add a dedicated calendar FTS index if
  // events ever fall outside it.
  const range = useMemo(() => {
    const now = new Date()
    return {
      startAt: new Date(now.getFullYear() - SEARCH_WINDOW_YEARS_PAST, 0, 1).toISOString(),
      endAt: new Date(now.getFullYear() + SEARCH_WINDOW_YEARS_FUTURE, 0, 1).toISOString(),
      includeUnselectedSources: true
    }
  }, [])

  const { data: rangeData, isLoading: rangeIsLoading } = useQuery({
    queryKey: calendarRangeKeys.range(range),
    queryFn: () => calendarService.getRange(range),
    enabled: open
  })

  const results = useMemo(
    () => filterCalendarItems(rangeData?.items ?? [], query, nowMs),
    [rangeData, query, nowMs]
  )

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      }),
    [i18n.language]
  )

  const timeFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { hour: 'numeric', minute: '2-digit' }),
    [i18n.language]
  )

  const close = (): void => {
    setOpen(false)
    setQuery('')
  }

  const jump = (item: CalendarProjectionItem): void => {
    onJump(item)
    close()
  }

  const formatWhen = (item: CalendarProjectionItem): string => {
    const start = new Date(item.startAt)
    if (item.isAllDay) return dateFormatter.format(start)
    return `${dateFormatter.format(start)} · ${timeFormatter.format(start)}`
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setNowMs(Date.now())
          setOpen(true)
        }}
        className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
        aria-label={t('search.open')}
      >
        <Search className="size-4" />
      </button>
    )
  }

  return (
    <div className="relative">
      <div className="flex h-9 items-center gap-1.5 rounded-full border border-border bg-background ps-3 pe-1.5">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              close()
            } else if (event.key === 'Enter' && results[0]) {
              // ponytail: Enter jumps to the top match; arrow-key row navigation
              // can be added if users ask for it.
              jump(results[0])
            }
          }}
          placeholder={t('search.placeholder')}
          aria-label={t('search.open')}
          className="w-44 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          onClick={close}
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
          aria-label={t('search.close')}
        >
          <X className="size-4" />
        </button>
      </div>

      {query.trim() && (
        <div className="absolute end-0 top-full z-50 mt-2 max-h-80 w-80 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {rangeIsLoading ? t('state.preparing') : t('search.no-results')}
            </p>
          ) : (
            results.map((item) => (
              <button
                key={item.projectionId}
                type="button"
                onClick={() => jump(item)}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-start transition-colors hover:bg-accent"
              >
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full ring-1 ring-border"
                  style={{ backgroundColor: VISUAL_TYPE_META[item.visualType].dotColor }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">
                    {item.title || t('time.new-event')}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {formatWhen(item)}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export default CalendarSearch
