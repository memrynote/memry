import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  calendarService,
  onCalendarChanged,
  type GetCalendarRangeInput,
  type CalendarRangeResponse
} from '@/services/calendar-service'

export const calendarRangeKeys = {
  all: () => ['calendar', 'range'] as const,
  range: (input: GetCalendarRangeInput) =>
    ['calendar', 'range', input.startAt, input.endAt, Boolean(input.includeUnselectedSources)] as const
}

export function useCalendarRange(input: GetCalendarRangeInput) {
  const queryClient = useQueryClient()

  const query = useQuery<CalendarRangeResponse>({
    queryKey: calendarRangeKeys.range(input),
    queryFn: () => calendarService.getRange(input)
  })

  useEffect(() => {
    return onCalendarChanged(() => {
      void queryClient.invalidateQueries({ queryKey: calendarRangeKeys.all() })
    })
  }, [queryClient])

  return {
    ...query,
    items: query.data?.items ?? []
  }
}

export default useCalendarRange
