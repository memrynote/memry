import type { CalendarProjectionItem } from '@/services/calendar-service'

export const MAX_SEARCH_RESULTS = 20

/**
 * Filter the unified calendar projection by free text (title + description),
 * sorted by temporal proximity to `nowMs` so the nearest matches surface first.
 */
export function filterCalendarItems(
  items: CalendarProjectionItem[],
  query: string,
  nowMs: number,
  limit = MAX_SEARCH_RESULTS
): CalendarProjectionItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return []

  return items
    .filter((item) => {
      const title = item.title?.toLowerCase() ?? ''
      const desc = item.descriptionPreview?.toLowerCase() ?? ''
      return title.includes(q) || desc.includes(q)
    })
    .sort(
      (a, b) =>
        Math.abs(new Date(a.startAt).getTime() - nowMs) -
        Math.abs(new Date(b.startAt).getTime() - nowMs)
    )
    .slice(0, limit)
}
