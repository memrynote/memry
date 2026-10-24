import { useQuery } from '@tanstack/react-query'
import { listGoogleCalendars, type ListGoogleCalendarsResponse } from '@/services/calendar-service'

const CALENDAR_LIST_STALE_TIME = 5 * 60 * 1000
const CALENDAR_LIST_GC_TIME = 30 * 60 * 1000

export const googleCalendarsQueryKey = ['calendar', 'google', 'list'] as const

export interface UseGoogleCalendarsResult {
  data: ListGoogleCalendarsResponse | undefined
  isLoading: boolean
  error: Error | null
}

export function useGoogleCalendars(enabled: boolean = true): UseGoogleCalendarsResult {
  const { data, isLoading, error } = useQuery({
    queryKey: googleCalendarsQueryKey,
    queryFn: listGoogleCalendars,
    enabled,
    staleTime: CALENDAR_LIST_STALE_TIME,
    gcTime: CALENDAR_LIST_GC_TIME
  })
  return {
    data,
    isLoading,
    error: error ?? null
  }
}
