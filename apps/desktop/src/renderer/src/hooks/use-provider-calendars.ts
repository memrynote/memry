import { useQuery } from '@tanstack/react-query'
import {
  GOOGLE_CALENDAR_PROVIDER_ID,
  listProviderCalendars,
  type ListProviderCalendarsResponse
} from '@/services/calendar-service'

const CALENDAR_LIST_STALE_TIME = 5 * 60 * 1000
const CALENDAR_LIST_GC_TIME = 30 * 60 * 1000

/** Namespaced by provider so two providers never share a cache slot. */
export const providerCalendarsQueryKey = (providerId: string) =>
  ['calendar', providerId, 'list'] as const

export interface UseProviderCalendarsResult {
  data: ListProviderCalendarsResponse | undefined
  isLoading: boolean
  error: Error | null
}

export function useProviderCalendars(
  providerId: string = GOOGLE_CALENDAR_PROVIDER_ID,
  enabled: boolean = true
): UseProviderCalendarsResult {
  const { data, isLoading, error } = useQuery({
    queryKey: providerCalendarsQueryKey(providerId),
    queryFn: () => listProviderCalendars(providerId),
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
