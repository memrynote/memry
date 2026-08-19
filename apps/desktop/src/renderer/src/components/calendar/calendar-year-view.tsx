import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { formatTimeOfDay } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import {
  getMonthGridDaysFixed,
  getWeekdayLabels,
  isToday,
  isSameMonth,
  parseLocalDate,
  toLocalDateKey,
  toLocalDateString
} from './date-utils'
import { useWeekStartsOn } from '@/hooks/use-calendar-preferences'
import { EVENT_TYPE_COLORS } from '@/lib/event-type-colors'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import type { CalendarWorkspaceView } from './calendar-toolbar'
import type { AnchorRect } from './types'
import { useTabScrollRestore } from '@/hooks/use-tab-scroll-restore'
import { CALENDAR_SCROLL_KEYS } from '@/pages/calendar-view-state'

const CLICK_DELAY_MS = 250

function formatPopoverDate(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  }).format(parseLocalDate(day))
}

interface CalendarYearViewProps {
  anchorDate: string
  items: CalendarProjectionItem[]
  onSelectItem?: (item: CalendarProjectionItem, rect: AnchorRect) => void
  onViewChange?: (view: CalendarWorkspaceView) => void
  onAnchorChange?: (date: string) => void
}

export function CalendarYearView({
  anchorDate,
  items,
  onSelectItem,
  onViewChange,
  onAnchorChange
}: CalendarYearViewProps): React.JSX.Element {
  const {
    settings: { clockFormat }
  } = useGeneralSettings()
  const { t, i18n } = useT('calendar')
  const weekStartsOn = useWeekStartsOn()
  const [popoverDay, setPopoverDay] = useState<string | null>(null)
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollRef = useRef<HTMLElement>(null)
  const getScrollEl = useCallback(() => scrollRef.current, [])
  useTabScrollRestore({ getScrollElement: getScrollEl, key: CALENDAR_SCROLL_KEYS.year })

  function formatPopoverTime(item: CalendarProjectionItem): string {
    if (item.isAllDay) return t('time.all-day-lower')
    return formatTimeOfDay(new Date(item.startAt), clockFormat)
  }

  useEffect(() => {
    return () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    }
  }, [])

  const year = parseLocalDate(anchorDate).getFullYear()

  const months = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const monthDate = new Date(year, i, 1)
        const monthAnchor = toLocalDateString(monthDate)
        return {
          monthAnchor,
          label: new Intl.DateTimeFormat(i18n.language, { month: 'long' }).format(monthDate),
          gridDays: getMonthGridDaysFixed(monthAnchor, weekStartsOn)
        }
      }),
    [i18n.language, year, weekStartsOn]
  )
  const dayHeaders = useMemo(
    () => getWeekdayLabels(i18n.language, weekStartsOn, 'narrow'),
    [i18n.language, weekStartsOn]
  )

  const itemsByDay = useMemo(() => {
    const map = new Map<string, CalendarProjectionItem[]>()
    for (const item of items) {
      const key = toLocalDateKey(item.startAt)
      const existing = map.get(key)
      if (existing) {
        existing.push(item)
      } else {
        map.set(key, [item])
      }
    }
    return map
  }, [items])

  function handleDayClick(day: string): void {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null
      setPopoverDay((current) => (current === day ? null : day))
    }, CLICK_DELAY_MS)
  }

  function handleDayDoubleClick(day: string): void {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    setPopoverDay(null)
    onAnchorChange?.(day)
    onViewChange?.('month')
  }

  const popoverItems = popoverDay ? (itemsByDay.get(popoverDay) ?? []) : []

  return (
    <Popover
      open={popoverDay !== null}
      onOpenChange={(open) => {
        if (!open) setPopoverDay(null)
      }}
    >
      {/* pt clears the floating chrome so months scroll beneath its material */}
      <section
        ref={scrollRef}
        data-calendar-scroll
        className="h-full overflow-y-auto px-3 pb-3 pt-14 @lg:px-6 @lg:pb-4 @3xl:px-8 @3xl:pb-6"
        data-testid="calendar-view"
        data-view="year"
      >
        <div className="grid grid-cols-2 gap-4 @lg:grid-cols-3 @lg:gap-x-6 @lg:gap-y-6 @3xl:grid-cols-4 @3xl:gap-x-10 @3xl:gap-y-8">
          {months.map((month) => (
            <div key={month.monthAnchor}>
              <h3 className="mb-2 text-sm font-semibold tracking-tight text-tint">{month.label}</h3>

              <div className="mb-1 grid grid-cols-7">
                {dayHeaders.map((header, i) => (
                  <span
                    key={i}
                    className="py-0.5 text-center text-xs font-medium text-muted-foreground"
                  >
                    {header}
                  </span>
                ))}
              </div>

              <div className="grid grid-cols-7">
                {month.gridDays.map((day) => {
                  const inMonth = isSameMonth(day, month.monthAnchor)
                  const today = isToday(day)
                  const dayNum = parseInt(day.slice(-2), 10)
                  const hasEvents = itemsByDay.has(day)
                  const isActive = popoverDay === day

                  const button = (
                    <button
                      key={day}
                      type="button"
                      className="relative flex flex-col items-center py-0.5"
                      onClick={() => handleDayClick(day)}
                      onDoubleClick={() => handleDayDoubleClick(day)}
                      aria-label={formatPopoverDate(day, i18n.language)}
                    >
                      <span
                        className={cn(
                          'flex size-5 items-center justify-center rounded-full text-[10px] @lg:size-7 @lg:text-xs',
                          today && 'bg-tint font-semibold text-tint-foreground',
                          !today && inMonth && 'text-foreground hover:bg-surface-active',
                          !today && !inMonth && 'text-muted-foreground'
                        )}
                      >
                        {dayNum}
                      </span>
                      {hasEvents && !today && (
                        <span className="absolute bottom-0 size-1 rounded-full bg-tint" />
                      )}
                    </button>
                  )

                  if (isActive) {
                    return (
                      <PopoverAnchor key={day} asChild>
                        {button}
                      </PopoverAnchor>
                    )
                  }

                  return button
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        className="w-64 rounded-xl border-border bg-popover p-3 shadow-xl"
      >
        {popoverDay && (
          <>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {formatPopoverDate(popoverDay, i18n.language)}
            </p>
            {popoverItems.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('empty.no-events')}</p>
            ) : (
              <div className="flex flex-col gap-1">
                {popoverItems.map((item) => (
                  <button
                    key={item.projectionId}
                    type="button"
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-start hover:bg-surface-active"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect()
                      onSelectItem?.(item, {
                        x: rect.left,
                        y: rect.top,
                        width: rect.width,
                        height: rect.height
                      })
                    }}
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor: item.source.color ?? EVENT_TYPE_COLORS[item.visualType]
                      }}
                    />
                    <span className="flex-1 truncate text-xs text-foreground">{item.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatPopoverTime(item)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

export default CalendarYearView
