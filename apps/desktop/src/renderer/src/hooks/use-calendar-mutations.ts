import { useMutation, useQueryClient } from '@tanstack/react-query'
import { calendarService, type CalendarDeleteResponse } from '@/services/calendar-service'
import { calendarRangeKeys } from './use-calendar-range'

export function useDeleteCalendarEvent() {
  const queryClient = useQueryClient()

  return useMutation<CalendarDeleteResponse, Error, string>({
    mutationFn: (id) => calendarService.deleteEvent(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: calendarRangeKeys.all() })
    }
  })
}
