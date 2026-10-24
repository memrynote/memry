import type {
  CalendarProjectionItem,
  CalendarProjectionVisualType
} from '@/services/calendar-service'
import { parseLocalDate } from '@/components/calendar/date-utils'

export const TIMELINE_HOUR_HEIGHT = 44
export const TIMELINE_SNAP_MINUTES = 30
/** A timed task without a duration, and any point-in-time item, draws this long. */
export const DEFAULT_BLOCK_MINUTES = 30
const MINUTES_IN_DAY = 1440
const MS_PER_MINUTE = 60_000

export interface TimelineItem {
  id: string
  sourceId: string
  kind: CalendarProjectionVisualType
  title: string
  startMin: number
  endMin: number
  item: CalendarProjectionItem
}

export interface PlacedTimelineItem extends TimelineItem {
  column: number
  columns: number
}

export interface DayTimelineModel {
  timed: TimelineItem[]
  allDay: CalendarProjectionItem[]
}

/**
 * Splits a day's projection into all-day items and timed items positioned in
 * minutes from the panel date's local midnight. Items that start before or end
 * after the day are clipped to it.
 */
export function buildDayTimeline(
  items: CalendarProjectionItem[],
  date: string,
  options: { includeTasks: boolean }
): DayTimelineModel {
  const dayStart = parseLocalDate(date).getTime()
  const timed: TimelineItem[] = []
  const allDay: CalendarProjectionItem[] = []
  for (const item of items) {
    if (item.visualType === 'task' && !options.includeTasks) continue
    if (item.isAllDay) {
      // An untimed task is the Unscheduled list's, not the all-day strip's.
      if (item.visualType !== 'task') allDay.push(item)
      continue
    }
    const start = (Date.parse(item.startAt) - dayStart) / MS_PER_MINUTE
    const end = item.endAt ? (Date.parse(item.endAt) - dayStart) / MS_PER_MINUTE : start
    const startMin = Math.max(0, Math.round(start))
    const endMin = Math.min(
      MINUTES_IN_DAY,
      Math.round(Math.max(end, start + DEFAULT_BLOCK_MINUTES))
    )
    if (startMin >= MINUTES_IN_DAY || endMin <= 0) continue
    timed.push({
      id: item.projectionId,
      sourceId: item.sourceId,
      kind: item.visualType,
      title: item.title,
      startMin,
      endMin,
      item
    })
  }
  timed.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin)
  return { timed, allDay }
}

/**
 * Lays overlapping items side by side. Items that overlap transitively form a
 * cluster; each item takes the first column free at its start, and every item
 * in the cluster shares the cluster's column count.
 */
export function packColumns(items: TimelineItem[]): PlacedTimelineItem[] {
  const sorted = [...items].toSorted((a, b) => a.startMin - b.startMin || b.endMin - a.endMin)
  const placed: PlacedTimelineItem[] = []
  let cluster: PlacedTimelineItem[] = []
  let columnEnds: number[] = []
  let clusterEnd = -1

  const closeCluster = (): void => {
    for (const entry of cluster) entry.columns = columnEnds.length
    placed.push(...cluster)
    cluster = []
    columnEnds = []
  }

  for (const item of sorted) {
    if (item.startMin >= clusterEnd) closeCluster()
    let column = columnEnds.findIndex((end) => end <= item.startMin)
    if (column === -1) {
      column = columnEnds.length
      columnEnds.push(item.endMin)
    } else {
      columnEnds[column] = item.endMin
    }
    cluster.push({ ...item, column, columns: 0 })
    clusterEnd = Math.max(clusterEnd, item.endMin)
  }
  closeCluster()
  return placed
}

/**
 * The duration a bottom-edge resize lands on: 30 min, 1 h, then whole hours,
 * whichever is nearest to the dragged length, capped at the end of the day.
 */
export function resizeSteps(
  currentMinutes: number,
  deltaPx: number,
  hourHeight: number,
  maxMinutes = MINUTES_IN_DAY
): number {
  const raw = currentMinutes + (deltaPx / hourHeight) * 60
  const stepped = raw < 45 ? 30 : Math.max(60, Math.round(raw / 60) * 60)
  if (stepped <= maxMinutes) return stepped
  return maxMinutes >= 60 ? Math.floor(maxMinutes / 60) * 60 : 30
}

function minutesOfDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes()
}

/** Today opens with now - 15 min at the top; any other day opens at 08:00. */
export function initialScrollMinutes(date: string, today: string, now: Date): number {
  return date === today ? Math.max(0, minutesOfDay(now) - 15) : 8 * 60
}

/** Minutes from midnight that are already past: all of a past day, none of a future one. */
export function pastMinutes(date: string, today: string, now: Date): number {
  if (date < today) return MINUTES_IN_DAY
  if (date > today) return 0
  return minutesOfDay(now)
}
