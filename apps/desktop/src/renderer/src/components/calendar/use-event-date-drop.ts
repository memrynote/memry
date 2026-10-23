import { useDndMonitor } from '@dnd-kit/core'
import { dayIndexFromDate, toLocalDateKey } from './date-utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'

/**
 * Date-granular moves, the counterpart of use-event-drag's time-grid moves:
 * an event chip dropped on a month cell or an all-day cell lands on that day
 * and keeps its wall-clock time, duration and all-day flag. Same gate as the
 * time grid: only Memry events whose projection allows moving. Imported
 * external events never get here.
 */
export function isEventDateMovable(item: CalendarProjectionItem): boolean {
  return item.sourceType === 'event' && item.editability?.canMove
}

function shiftLocalDays(iso: string, days: number): string {
  const date = new Date(iso)
  date.setDate(date.getDate() + days)
  return date.toISOString()
}

/** New times for `item` starting on `targetDate`, or null when it already starts there. */
export function eventTimesOnDate(
  item: CalendarProjectionItem,
  targetDate: string
): { startAt: string; endAt: string | null } | null {
  const days = dayIndexFromDate(targetDate) - dayIndexFromDate(toLocalDateKey(item.startAt))
  if (days === 0) return null
  return {
    startAt: shiftLocalDays(item.startAt, days),
    endAt: item.endAt ? shiftLocalDays(item.endAt, days) : null
  }
}

/**
 * Commits an event chip drop on a calendar date cell. The time-grid columns
 * (`timeBehavior: 'slot'`) are excluded: timed moves there go through
 * use-event-drag, and an all-day event has no slot time.
 */
export function useEventDateDrop(
  onMove: (item: CalendarProjectionItem, startAt: string, endAt: string | null) => void
): void {
  useDndMonitor({
    onDragEnd: ({ active, over }) => {
      const item = active.data.current?.calendarItem as CalendarProjectionItem | undefined
      const overData = over?.data.current
      if (!item || overData?.type !== 'date' || overData.timeBehavior === 'slot') return
      if (typeof overData.dateKey !== 'string' || !isEventDateMovable(item)) return
      const times = eventTimesOnDate(item, overData.dateKey)
      if (times) onMove(item, times.startAt, times.endAt)
    }
  })
}
