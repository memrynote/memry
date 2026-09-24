import { caldavCalendarProvider } from '../caldav/caldav-provider'
import { appleEventKitCalendarProvider } from '../eventkit/eventkit-provider'
import { googleCalendarProvider } from '../google/google-provider'
import { icsCalendarProvider } from '../ics/ics-provider'
import { registerProvider } from './registry'

/** Register every provider this build ships. Idempotent. */
export function registerBuiltinCalendarProviders(): void {
  registerProvider(googleCalendarProvider)
  registerProvider(icsCalendarProvider)
  registerProvider(caldavCalendarProvider)
  // Registered everywhere so its IPC can answer `unsupported_platform`, but
  // `platforms: ['darwin']` keeps it out of listProviders()/getProvider() on
  // Windows and Linux. Registering loads no native code (#1405).
  registerProvider(appleEventKitCalendarProvider)
}
