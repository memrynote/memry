import {
  CALDAV_CALENDAR_PROVIDER,
  GOOGLE_CALENDAR_PROVIDER,
  ICS_CALENDAR_PROVIDER,
  type CalendarProviderCapabilities
} from '@memry/contracts/calendar-api'

/**
 * Declared capabilities per provider (#1391). Each entry reproduces what the
 * provider already does; the table names the behaviour, it does not change it.
 */
export const PROVIDER_CAPABILITIES: Readonly<Record<string, CalendarProviderCapabilities>> = {
  [GOOGLE_CALENDAR_PROVIDER]: {
    supportsWrite: true,
    supportsCreateCalendar: true,
    supportsPush: true,
    supportsMultiAccount: true,
    // Google sync is gated on isMemryUserSignedIn(): the push relay and token
    // refresh go through the Memry account.
    requiresMemryAccount: true,
    mirrorScope: 'synced',
    sourceScope: 'synced',
    incrementalMode: 'sync-token',
    authFlow: 'oauth2'
  },
  [ICS_CALENDAR_PROVIDER]: {
    supportsWrite: false,
    supportsCreateCalendar: false,
    supportsPush: false,
    supportsMultiAccount: false,
    requiresMemryAccount: false,
    // Every device reads the feed itself; validators live in memory, so the
    // mirror stays on the device (#2355).
    mirrorScope: 'device',
    sourceScope: 'synced',
    incrementalMode: 'conditional-get',
    authFlow: 'url'
  },
  [CALDAV_CALENDAR_PROVIDER]: {
    // Read-only until write-back lands (#1400).
    supportsWrite: false,
    // MKCALENDAR is optional server-side and Memry never needs its own
    // collection: the default write target is always an existing calendar.
    supportsCreateCalendar: false,
    supportsPush: false,
    supportsMultiAccount: true,
    // Like ICS, CalDAV talks to the server directly.
    requiresMemryAccount: false,
    // #1399 decision: synced. Credentials never leave the device, so with a
    // device-local mirror a second device would show the account as needing
    // its password and no events at all until the app password is entered
    // there too. A synced mirror is what Google users already get, and an app
    // password per device is real friction. The rule from #1391 holds: the
    // sync-token/ctag cursor lives on the synced source row, so it travels
    // with the mirror.
    mirrorScope: 'synced',
    sourceScope: 'synced',
    incrementalMode: 'sync-collection',
    authFlow: 'basic',
    pollIntervalMs: 15 * 60 * 1000
  }
}

/**
 * What an unknown provider id gets: nothing writable, nothing synced from this
 * device. A row written by a newer build for a provider this build does not
 * know must never be pushed to, promoted, or re-enqueued.
 */
export const UNKNOWN_PROVIDER_CAPABILITIES: CalendarProviderCapabilities = {
  supportsWrite: false,
  supportsCreateCalendar: false,
  supportsPush: false,
  supportsMultiAccount: false,
  requiresMemryAccount: false,
  mirrorScope: 'device',
  sourceScope: 'synced',
  incrementalMode: 'full',
  authFlow: 'url'
}

export function providerCapabilities(providerId: string): CalendarProviderCapabilities {
  return PROVIDER_CAPABILITIES[providerId] ?? UNKNOWN_PROVIDER_CAPABILITIES
}

export function isKnownProvider(providerId: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDER_CAPABILITIES, providerId)
}

export function sourceCapabilities(source: { provider: string }): CalendarProviderCapabilities {
  return providerCapabilities(source.provider)
}

export function isProviderAvailableOn(
  capabilities: Pick<CalendarProviderCapabilities, 'platforms'>,
  platform: string = process.platform
): boolean {
  return !capabilities.platforms || (capabilities.platforms as string[]).includes(platform)
}
