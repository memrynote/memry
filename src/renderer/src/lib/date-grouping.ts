import {
  isToday,
  isYesterday,
  isWithinInterval,
  subDays,
  startOfDay,
  format,
  formatDistanceToNow
} from 'date-fns'

export type DateGroup = 'today' | 'yesterday' | 'pastWeek' | 'past30Days' | 'older'

export interface DateGroupedItem<T> {
  group: DateGroup
  label: string
  items: T[]
}

export interface GroupedResults<T> {
  today: T[]
  yesterday: T[]
  pastWeek: T[]
  past30Days: T[]
  older: T[]
}

const GROUP_LABELS: Record<DateGroup, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  pastWeek: 'Past week',
  past30Days: 'Past 30 days',
  older: 'Older'
}

export function getDateGroupLabel(group: DateGroup): string {
  return GROUP_LABELS[group]
}

export function getDateGroup(date: Date | string): DateGroup {
  const d = typeof date === 'string' ? new Date(date) : date
  const now = new Date()

  if (isToday(d)) {
    return 'today'
  }

  if (isYesterday(d)) {
    return 'yesterday'
  }

  const weekAgo = startOfDay(subDays(now, 7))
  if (isWithinInterval(d, { start: weekAgo, end: now })) {
    return 'pastWeek'
  }

  const monthAgo = startOfDay(subDays(now, 30))
  if (isWithinInterval(d, { start: monthAgo, end: now })) {
    return 'past30Days'
  }

  return 'older'
}

export function groupByDate<T>(items: T[], getDate: (item: T) => string | Date): GroupedResults<T> {
  const groups: GroupedResults<T> = {
    today: [],
    yesterday: [],
    pastWeek: [],
    past30Days: [],
    older: []
  }

  for (const item of items) {
    const date = getDate(item)
    const group = getDateGroup(date)
    groups[group].push(item)
  }

  return groups
}

export function groupByDateWithLabels<T>(
  items: T[],
  getDate: (item: T) => string | Date
): DateGroupedItem<T>[] {
  const grouped = groupByDate(items, getDate)
  const result: DateGroupedItem<T>[] = []

  const groupOrder: DateGroup[] = ['today', 'yesterday', 'pastWeek', 'past30Days', 'older']

  for (const group of groupOrder) {
    if (grouped[group].length > 0) {
      result.push({
        group,
        label: getDateGroupLabel(group),
        items: grouped[group]
      })
    }
  }

  return result
}

export function formatRelativeDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date

  if (isToday(d)) {
    return format(d, 'h:mm a')
  }

  if (isYesterday(d)) {
    return 'Yesterday'
  }

  const now = new Date()
  const weekAgo = subDays(now, 7)

  if (d >= weekAgo) {
    return formatDistanceToNow(d, { addSuffix: true })
  }

  const yearAgo = subDays(now, 365)
  if (d >= yearAgo) {
    return format(d, 'MMM d')
  }

  return format(d, 'MMM d, yyyy')
}
