import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'
import { useT } from '@memry/i18n/renderer'
import { useOptionalDragContext } from '@/contexts/drag-context'
import { getEventBaseColor } from '@/lib/event-type-colors'
import { formatTimeOfDay, type ClockFormat } from '@/lib/time-format'
import { parseLocalDate } from '@/components/calendar/date-utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import {
  TIMELINE_HOUR_HEIGHT,
  buildDayTimeline,
  initialScrollMinutes,
  packColumns,
  pastMinutes
} from './timeline-layout'
import { TimelineEventBlock, TimelineTaskBlock } from './timeline-blocks'
import { useTimelineDrag } from './use-timeline-drag'

const VISIBLE_HOURS = 6
const HOURS = Array.from({ length: 24 }, (_, hour) => hour)
const H = TIMELINE_HOUR_HEIGHT

function todayKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function DropLayer({
  date,
  scrollRef,
  columnRef,
  formatTime,
  onDropTask
}: {
  date: string
  scrollRef: RefObject<HTMLDivElement | null>
  columnRef: RefObject<HTMLDivElement | null>
  formatTime: (minutes: number) => string
  onDropTask: (taskId: string, dueTime: string) => void
}): React.JSX.Element | null {
  const { t } = useT('journal')
  const { setDropRef, preview } = useTimelineDrag({ date, scrollRef, columnRef, onDropTask })
  return (
    <div
      ref={setDropRef}
      data-testid="day-timeline-drop"
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-md"
    >
      {preview && (
        <div
          data-testid="timeline-drop-preview"
          className="absolute end-0 start-11 z-20 flex items-start rounded border border-dashed border-foreground/60 bg-tint/15 px-1.5"
          style={{
            top: preview.startMin * (H / 60) - preview.scrollTop,
            height: (preview.endMin - preview.startMin) * (H / 60)
          }}
        >
          <span className="font-mono text-[10px] font-semibold tabular-nums text-foreground">
            {t('dayTimeline.range', {
              start: formatTime(preview.startMin),
              end: formatTime(preview.endMin)
            })}
          </span>
        </div>
      )}
    </div>
  )
}

export function DayTimeline({
  date,
  items,
  includeTasks,
  clockFormat,
  onCompleteTask,
  onOpenTask,
  onResizeTask,
  onScheduleTask,
  onHoverColor
}: {
  date: string
  items: CalendarProjectionItem[]
  includeTasks: boolean
  clockFormat: ClockFormat
  onCompleteTask: (taskId: string) => void
  onOpenTask: (taskId: string) => void
  onResizeTask: (taskId: string, minutes: number) => void
  onScheduleTask: (taskId: string, dueTime: string) => void
  onHoverColor?: (color: string | null) => void
}): React.JSX.Element {
  const { t } = useT('journal')
  const hasDragContext = useOptionalDragContext() !== null
  const scrollRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  const today = todayKey(now)
  const isToday = date === today

  const { timed, allDay } = useMemo(
    () => buildDayTimeline(items, date, { includeTasks }),
    [items, date, includeTasks]
  )
  const placed = useMemo(() => packColumns(timed), [timed])
  const past = pastMinutes(date, today, now)

  const formatTime = useCallback(
    (minutes: number) => {
      const at = parseLocalDate(date)
      at.setMinutes(minutes)
      return formatTimeOfDay(at, clockFormat)
    },
    [date, clockFormat]
  )

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (scroller)
      scroller.scrollTop = initialScrollMinutes(date, todayKey(new Date()), new Date()) * (H / 60)
  }, [date])

  return (
    <div className="flex flex-col gap-1.5" data-testid="day-timeline">
      {allDay.length > 0 && (
        <ul aria-label={t('dayTimeline.allDay')} className="flex flex-wrap gap-1">
          {allDay.map((item) => (
            <li
              key={item.projectionId}
              className="max-w-full truncate rounded border-s-2 bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground/90"
              style={{ borderColor: getEventBaseColor(item.visualType) }}
            >
              {item.title}
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <section
          ref={scrollRef}
          data-testid="day-timeline-scroll"
          aria-label={t('dayTimeline.label')}
          className="relative overflow-y-auto overscroll-contain rounded-md border border-border/40"
          style={{ height: VISIBLE_HOURS * H }}
        >
          <div className="relative flex" style={{ height: 24 * H }}>
            <div className="w-11 shrink-0" aria-hidden="true">
              {HOURS.map((hour) => (
                <div
                  key={hour}
                  className="relative -top-1.5 whitespace-nowrap pe-1.5 text-end font-mono text-[10px] tabular-nums leading-none text-muted-foreground"
                  style={{ height: H }}
                >
                  {hour === 0 ? '' : formatTime(hour * 60).replace(':00 ', ' ')}
                </div>
              ))}
            </div>
            <div ref={columnRef} className="relative flex-1 border-s border-border/40">
              {HOURS.map((hour) => (
                <div
                  key={hour}
                  aria-hidden="true"
                  className="absolute inset-x-0 border-t border-border/40"
                  style={{ top: hour * H }}
                />
              ))}
              {past > 0 && (
                <div
                  data-testid="timeline-past"
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 top-0 bg-muted/50"
                  style={{ height: past * (H / 60) }}
                />
              )}
              {placed.map((entry) =>
                entry.kind === 'task' ? (
                  <TimelineTaskBlock
                    key={entry.id}
                    placed={entry}
                    hourHeight={H}
                    formatTime={formatTime}
                    onComplete={onCompleteTask}
                    onOpen={onOpenTask}
                    onResize={onResizeTask}
                  />
                ) : (
                  <TimelineEventBlock
                    key={entry.id}
                    placed={entry}
                    hourHeight={H}
                    timeLabel={t('dayTimeline.range', {
                      start: formatTime(entry.startMin),
                      end: formatTime(entry.endMin)
                    })}
                    onHoverColor={onHoverColor}
                  />
                )
              )}
              {isToday && (
                <div
                  data-testid="timeline-now"
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-destructive"
                  style={{ top: past * (H / 60) }}
                />
              )}
            </div>
          </div>
        </section>
        {hasDragContext && includeTasks && (
          <DropLayer
            date={date}
            scrollRef={scrollRef}
            columnRef={columnRef}
            formatTime={formatTime}
            onDropTask={onScheduleTask}
          />
        )}
      </div>
    </div>
  )
}
