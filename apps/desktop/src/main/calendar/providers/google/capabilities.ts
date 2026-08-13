import type { CalendarProviderCapabilities } from '@memry/contracts/calendar-api'

export const GOOGLE_PROVIDER_ID = 'google'

/**
 * Kept in its own module so the sync binding and the registry definition can
 * both read it without importing each other.
 */
export const GOOGLE_CAPABILITIES: CalendarProviderCapabilities = {
  supportsWrite: true,
  supportsCreateCalendar: true,
  supportsPush: true,
  supportsMultiAccount: true,
  incrementalMode: 'sync-token',
  authFlow: 'oauth2'
}
