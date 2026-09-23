import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  calendarService,
  type GetCalendarRangeInput,
  type CalendarRangeResponse
} from '@/services/calendar-service'

export const calendarRangeKeys = {
  all: () => ['calendar', 'range'] as const,
  range: (input: GetCalendarRangeInput) =>
    [
      'calendar',
      'range',
      input.startAt,
      input.endAt,
      Boolean(input.includeUnselectedSources)
    ] as const
}

/**
 * A calendar projection for one range.
 *
 * Keeping these caches fresh is `useCalendarChangeEvents`' job, mounted once in
 * App.tsx. It used to be done here, per consumer, which meant a range only heard
 * about a change while something was rendering it — and only the active tab of a
 * group is mounted, so a background board never caught up.
 */
export function useCalendarRange(
  input: GetCalendarRangeInput,
  options: {
    /**
     * Keep showing the previous range while the next one loads. The timeline
     * slides its range as it scrolls; without this its events would blink out
     * on every slide.
     */
    keepPrevious?: boolean
  } = {}
) {
  const query = useQuery<CalendarRangeResponse>({
    queryKey: calendarRangeKeys.range(input),
    queryFn: () => calendarService.getRange(input),
    placeholderData: options.keepPrevious ? keepPreviousData : undefined
  })

  return {
    ...query,
    items: query.data?.items ?? []
  }
}

export default useCalendarRange
