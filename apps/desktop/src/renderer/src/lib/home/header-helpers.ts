// Pure helpers for the Home header (greeting + live metrics). Kept data-less so
// they're trivially unit-testable; the component supplies counts and i18n.

export type GreetingKey = 'morning' | 'afternoon' | 'evening'

export function getGreetingKey(hour: number): GreetingKey {
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  return 'evening'
}

export type HeaderMetricKey = 'tasksDue' | 'events'

export interface HeaderMetricCounts {
  tasksDue: number
  events: number
}

export interface HeaderMetric {
  key: HeaderMetricKey
  count: number
}

// Ordered list of metrics to show, dropping any with a zero (or negative) count.
export function buildHeaderMetrics(counts: HeaderMetricCounts): HeaderMetric[] {
  return (
    [
      { key: 'tasksDue', count: counts.tasksDue },
      { key: 'events', count: counts.events }
    ] as const
  )
    .filter((m) => m.count > 0)
    .map((m) => ({ ...m }))
}
