import { caldavCalendarProvider } from '../caldav/caldav-provider'
import { googleCalendarProvider } from '../google/google-provider'
import { icsCalendarProvider } from '../ics/ics-provider'
import { registerProvider } from './registry'

/** Register every provider this build ships. Idempotent. */
export function registerBuiltinCalendarProviders(): void {
  registerProvider(googleCalendarProvider)
  registerProvider(icsCalendarProvider)
  registerProvider(caldavCalendarProvider)
}
