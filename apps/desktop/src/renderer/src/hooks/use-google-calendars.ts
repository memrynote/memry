import {
  providerCalendarsQueryKey,
  useProviderCalendars,
  type UseProviderCalendarsResult
} from './use-provider-calendars'

/**
 * Google-bound view of `useProviderCalendars`. Kept so the onboarding dialog
 * and the calendar target picker keep their import paths.
 */
export const googleCalendarsQueryKey = providerCalendarsQueryKey('google')

export type UseGoogleCalendarsResult = UseProviderCalendarsResult

export function useGoogleCalendars(enabled: boolean = true): UseGoogleCalendarsResult {
  return useProviderCalendars('google', enabled)
}
